import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import crypto from 'crypto';
import { ApifyClient } from 'apify-client';
import Groq from 'groq-sdk';
import 'dotenv/config';

const groq = new Groq({
    apiKey: (process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || '').split(',')[0].trim()
});

// Initialize the ApifyClient
const apifyClient = new ApifyClient({
    token: process.env.APIFY_TOKEN,
});

import express from 'express';
import cors from 'cors';

const app = express();
const port = process.env.PORT || 5001;

const connection = process.env.REDIS_URL
    ? new IORedis(process.env.REDIS_URL, {
        maxRetriesPerRequest: null,
        // MUST add this for Upstash + Render
        tls: {
            rejectUnauthorized: false
        }
    })
    : new IORedis({
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        maxRetriesPerRequest: null,
    });

connection.on('connect', () => console.log('✅ Connected to Redis!'));
connection.on('error', (err) => {
    if (err.message.includes('ETIMEDOUT')) return;
    console.error('❌ Redis Error:', err.message);
});

// BullMQ Queue
const summarizeQueue = new Queue('summarize', { connection });

// In-memory cache: videoUrl -> summary
const summaryCache = new Map();

const allowedOrigins = [
    'https://yt-transcript-sooty.vercel.app'
];

app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
            return callback(null, true);
        }
        callback(new Error(`CORS origin denied: ${origin}`));
    },
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false,
    optionsSuccessStatus: 200,
}));
app.options('*', cors());
app.use(express.json());

// Helper: generate a cache key from video URL
function getCacheKey(videoUrl) {
    return crypto.createHash('md5').update(videoUrl.trim()).digest('hex');
}

// ─── Transcript Endpoint (using Apify) ─────────────────────────
app.post('/api/transcript', async (req, res) => {
    try {
        const { url } = req.body;
        if (!url) return res.status(400).json({ error: 'Video URL is required' });

        console.log(`[Apify] Starting actor for: ${url}`);
        const input = {
            "outputFormat": "captions",
            "urls": [url],
            "maxRetries": 5,
            "proxyOptions": { "useApifyProxy": true }
        };

        const run = await apifyClient.actor("1s7eXiaukVuOr4Ueg").call(input);
        const { items } = await apifyClient.dataset(run.defaultDatasetId).listItems();

        if (!items || items.length === 0) {
            throw new Error('Apify dataset is empty');
        }

        // The actor might return data in .captions or .transcript or .text
        const rawCaptions = items[0].captions || items[0].transcript || items[0].text;

        if (!rawCaptions || !Array.isArray(rawCaptions)) {
            console.log('[Apify] Raw Item structure:', JSON.stringify(items[0]).substring(0, 500));
            throw new Error('Transcript format not recognized in Apify output');
        }

        const formattedTranscript = rawCaptions
            .filter(c => c && (c.text || typeof c === 'string'))
            .map(c => ({
                text: typeof c === 'string' ? c : c.text,
                offset: Math.floor((c.start || c.offset || 0) * 1000),
                duration: Math.floor((c.duration || 0) * 1000)
            }));

        console.log(`[Apify] Successfully parsed ${formattedTranscript.length} segments`);
        res.json({ content: formattedTranscript });

    } catch (error) {
        console.error('Apify Error:', error.message);
        res.status(500).json({ error: 'Transcript Fetch Failed', details: error.message });
    }
});

// ─── Submit Summarize Job ──────────────────────────────────────
app.post('/api/summarize', async (req, res) => {
    try {
        const { transcript, videoUrl } = req.body;

        if (!transcript || !Array.isArray(transcript)) {
            return res.status(400).json({ error: 'Transcript data is required' });
        }

        // Check cache first
        const cacheKey = getCacheKey(videoUrl || JSON.stringify(transcript.slice(0, 3)));
        if (summaryCache.has(cacheKey)) {
            console.log(`[Cache Hit] Returning cached summary for: ${videoUrl}`);
            return res.json({ jobId: `cached_${cacheKey}`, cached: true, summary: summaryCache.get(cacheKey) });
        }

        // Add job to queue
        const job = await summarizeQueue.add('summarize-video', {
            transcript,
            videoUrl: videoUrl || 'unknown',
            cacheKey,
        }, {
            attempts: 3,
            backoff: {
                type: 'exponential',
                delay: 20000, // 20s base backoff on retry
            },
            removeOnComplete: { age: 3600 }, // Keep completed jobs for 1 hour
            removeOnFail: { age: 7200 },     // Keep failed jobs for 2 hours
        });

        console.log(`[Queue] Job ${job.id} added for: ${videoUrl}`);

        // Return the job ID for polling
        res.json({ jobId: job.id, status: 'queued' });

    } catch (error) {
        console.error('Error submitting job:', error.message);
        res.status(500).json({
            error: 'Failed to submit summarization job',
            details: error.message
        });
    }
});

// ─── Poll Job Status ───────────────────────────────────────────
app.get('/api/summarize/status/:jobId', async (req, res) => {
    try {
        const { jobId } = req.params;

        // Handle cached results
        if (jobId.startsWith('cached_')) {
            const cacheKey = jobId.replace('cached_', '');
            const summary = summaryCache.get(cacheKey);
            if (summary) {
                return res.json({ status: 'completed', summary });
            }
            return res.json({ status: 'failed', error: 'Cache entry expired' });
        }

        const job = await summarizeQueue.getJob(jobId);

        if (!job) {
            return res.status(404).json({ status: 'not_found', error: 'Job not found' });
        }

        const state = await job.getState();
        const progress = job.progress;

        if (state === 'completed') {
            const result = job.returnvalue;
            // Cache the result
            if (result?.summary && job.data?.cacheKey) {
                summaryCache.set(job.data.cacheKey, result.summary);
            }
            return res.json({ status: 'completed', summary: result?.summary });
        }

        if (state === 'failed') {
            return res.json({ status: 'failed', error: job.failedReason || 'Unknown error' });
        }

        // Still processing
        const queuePosition = state === 'waiting' ? await getQueuePosition(jobId) : null;

        return res.json({
            status: state, // 'waiting', 'active', 'delayed'
            progress,
            queuePosition,
        });

    } catch (error) {
        console.error('Error checking job status:', error.message);
        res.status(500).json({ status: 'error', error: error.message });
    }
});

// Helper: get position in queue
async function getQueuePosition(jobId) {
    try {
        const waiting = await summarizeQueue.getWaiting(0, 50);
        const index = waiting.findIndex(j => j.id === jobId);
        return index >= 0 ? index + 1 : null;
    } catch {
        return null;
    }
}

// ─── Queue Stats (optional admin endpoint) ─────────────────────
app.get('/api/queue/stats', async (req, res) => {
    try {
        const counts = await summarizeQueue.getJobCounts();
        res.json({
            ...counts,
            cacheSize: summaryCache.size,
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// ─── Summarization Worker Logic (Consolidated) ───────────────────
const RATE_LIMIT_DELAY_MS = 15000; // 15s between chunks

async function summarizeChunks(transcript) {
    const CHUNK_SIZE_CHARS = 3000; // Small chunks for your 6000 TPM limit
    const RATE_LIMIT_DELAY = 15000; // 15s between chunks
    const chunks = [];
    let currentChunk = "";

    for (const segment of transcript) {
        if (!segment || !segment.text) continue;
        if ((currentChunk.length + segment.text.length) > CHUNK_SIZE_CHARS) {
            chunks.push(currentChunk);
            currentChunk = "";
        }
        currentChunk += segment.text + " ";
    }
    if (currentChunk) chunks.push(currentChunk);

    console.log(`[Worker] Summarizing transcript in ${chunks.length} chunks...`);

    let finalSummary = "";
    const apiKeys = (process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || '')
        .split(',')
        .map(k => k.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);

    for (let i = 0; i < chunks.length; i++) {
        // Rotate keys per chunk to multiply your rate limit
        const key = apiKeys[i % apiKeys.length];
        const client = new Groq({ apiKey: key });

        console.log(`[Worker] Processing chunk ${i + 1}/${chunks.length} using key ${i % apiKeys.length + 1}...`);

        try {
            const completion = await client.chat.completions.create({
                messages: [
                    {
                        role: "system",
                        content: "You are a professional content summarizer. CRITICAL: Regardless of the input language, your summary MUST be written entirely in English. Use clear, professional markdown."
                    },
                    { role: "user", content: chunks[i] }
                ],
                model: "openai/gpt-oss-20b",
            });

            finalSummary += (completion.choices[0]?.message?.content || "") + "\n\n";

            if (i < chunks.length - 1) {
                console.log(`[Worker] Waiting for rate limits...`);
                await new Promise(r => setTimeout(r, RATE_LIMIT_DELAY));
            }
        } catch (err) {
            console.error(`[Worker] Error in chunk ${i + 1}:`, err.message);
            // If we hit a limit even with rotation, wait longer
            if (err.message.includes('rate_limit')) {
                console.log('[Worker] Hit rate limit. Waiting 30s before retry...');
                await new Promise(r => setTimeout(r, 30000));
                i--; // Retry this chunk
                continue;
            }
            throw err;
        }
    }

    return finalSummary;
}

// Initialize Worker in the same process
const summarizeWorker = new Worker('summarize', async (job) => {
    console.log(`[Worker] Processing job ${job.id} for video: ${job.data.videoUrl || 'unknown'}`);
    const summary = await summarizeChunks(job.data.transcript);
    console.log(`[Worker] Job ${job.id} completed.`);
    return { summary };
}, {
    connection,
    concurrency: 1,
    limiter: { max: 1, duration: RATE_LIMIT_DELAY_MS }
});

summarizeWorker.on('completed', (job) => console.log(`[Worker] Success: Job ${job.id}`));
summarizeWorker.on('failed', (job, err) => console.error(`[Worker] Failed: Job ${job?.id}`, err.message));

// ─── Final Server Startup ───────────────────────────────────────
const server = app.listen(port, () => {
    console.log(`Backend server running on http://localhost:${port}`);
    console.log(`Redis connected. Worker ready.`);
});

server.on('error', (err) => {
    console.error('Server error:', err);
    process.exit(1);
});
