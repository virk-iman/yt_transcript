import express from 'express';
import cors from 'cors';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import crypto from 'crypto';
import { ApifyClient } from 'apify-client';
import 'dotenv/config';

// Initialize the ApifyClient
const apifyClient = new ApifyClient({
    token: process.env.APIFY_TOKEN,
});

const app = express();
const port = process.env.PORT || 5001;

// Redis connection logic
const connection = process.env.REDIS_URL
    ? new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null })
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

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
}));
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

// ─── Server ────────────────────────────────────────────────────
const server = app.listen(port, () => {
    console.log(`Backend server running on http://localhost:${port}`);
    console.log(`Redis connected. Queue ready.`);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${port} is already in use. Try a different port.`);
    } else {
        console.error('Server error:', err);
    }
    process.exit(1);
});
