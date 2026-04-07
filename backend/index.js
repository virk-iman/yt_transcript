import express from 'express';
import cors from 'cors';
import { YoutubeTranscript } from 'youtube-transcript/dist/youtube-transcript.esm.js';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import crypto from 'crypto';
import 'dotenv/config';

// ─── YouTube Bot Detection Bypass ────────────────────────────
const originalFetch = global.fetch;
global.fetch = (url, options = {}) => {
    return originalFetch(url, {
        ...options,
        headers: {
            ...options.headers,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
        },
    });
};

const app = express();
const port = process.env.PORT || 5001;

// Redis connection
const connection = process.env.REDIS_URL
    ? new IORedis(process.env.REDIS_URL, {
        maxRetriesPerRequest: null,
        connectTimeout: 20000,
        family: 4, // Upstash/Render works better if we force IPv4
    })
    : new IORedis({
        host: process.env.REDIS_HOST || '127.0.0.1',
        port: parseInt(process.env.REDIS_PORT || '6379'),
        maxRetriesPerRequest: null,
    });

connection.on('connect', () => console.log('Successfully connected to Redis.'));
connection.on('error', (err) => {
    // Suppress ETIMEDOUT logs if we are trying to reconnect
    if (err.message.includes('ETIMEDOUT')) return;
    console.error('Redis Error:', err.message);
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

// ─── Transcript Endpoint ───────────────────────────────────────
app.post('/api/transcript', async (req, res) => {
    try {
        const { url } = req.body;

        if (!url) {
            return res.status(400).json({ error: 'Video URL is required' });
        }

        console.log(`Fetching transcript for: ${url}`);

        const transcript = await YoutubeTranscript.fetchTranscript(url);
        console.log(`Got ${transcript.length} segments`);

        res.json({ content: transcript });

    } catch (error) {
        console.error('Error fetching transcript:', error.message);
        res.status(500).json({
            error: 'Failed to fetch transcript',
            details: error.message
        });
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
