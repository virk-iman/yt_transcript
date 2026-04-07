import { Worker } from 'bullmq';
import { Groq } from 'groq-sdk';
import 'dotenv/config';

// ─── API Key Rotation Pool ────────────────────────────────────
const apiKeys = (process.env.GROQ_API_KEYS || process.env.GROQ_API_KEY || '')
    .split(',')
    .map(k => k.trim().replace(/^["']|["']$/g, '')) // Remove leading/trailing quotes
    .filter(Boolean);

if (apiKeys.length === 0) {
    console.error('[Worker] No GROQ_API_KEYS found in .env! Exiting.');
    process.exit(1);
}

const groqClients = apiKeys.map(key => new Groq({ apiKey: key }));
let currentKeyIndex = 0;

function getNextClient() {
    const client = groqClients[currentKeyIndex];
    const keyIndex = currentKeyIndex;
    currentKeyIndex = (currentKeyIndex + 1) % groqClients.length;
    return { client, keyIndex };
}

console.log(`[Worker] Loaded ${groqClients.length} API key(s) for rotation.`);

// ─── Rate Limiting ────────────────────────────────────────────
const CHUNK_SIZE_CHARS = 8000;
const BASE_DELAY_MS = 20000;
// More keys = shorter delay between calls
const RATE_LIMIT_DELAY_MS = Math.max(5000, Math.floor(BASE_DELAY_MS / groqClients.length));

console.log(`[Worker] Rate limit delay: ${RATE_LIMIT_DELAY_MS}ms (${groqClients.length} key(s))`);

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ─── Helpers ──────────────────────────────────────────────────
function chunkTranscript(transcript) {
    const chunks = [];
    let currentChunk = "";
    for (const segment of transcript) {
        if ((currentChunk.length + segment.text.length) > CHUNK_SIZE_CHARS) {
            chunks.push(currentChunk);
            currentChunk = "";
        }
        currentChunk += segment.text + " ";
    }
    if (currentChunk) chunks.push(currentChunk);
    return chunks;
}

async function callGroqWithRetry(messages, maxTokens, maxRetries = 3) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        const { client, keyIndex } = getNextClient();
        try {
            const result = await client.chat.completions.create({
                messages,
                model: "openai/gpt-oss-20b",
                temperature: 1,
                max_completion_tokens: maxTokens,
                top_p: 1,
                stream: false,
                reasoning_effort: "medium",
            });
            console.log(`[Worker] Key #${keyIndex + 1} succeeded.`);
            return result;
        } catch (err) {
            const isRateLimit = err.status === 429 || err.status === 413;
            console.warn(`[Worker] Key #${keyIndex + 1} failed (${err.status || 'unknown'}). ${isRateLimit ? 'Rate limited.' : err.message}`);
            if (isRateLimit && attempt < maxRetries - 1) {
                await sleep(RATE_LIMIT_DELAY_MS);
                continue;
            }
            throw err;
        }
    }
}

// ─── Summarization Logic ──────────────────────────────────────
async function summarizeChunks(transcript, job) {
    const chunks = chunkTranscript(transcript);
    await job.updateProgress({ stage: 'chunking', total: chunks.length });

    const partialSummaries = [];
    for (let i = 0; i < chunks.length; i++) {
        if (i > 0) {
            await job.updateProgress({ stage: 'waiting', chunk: i + 1, total: chunks.length });
            await sleep(RATE_LIMIT_DELAY_MS);
        }

        await job.updateProgress({ stage: 'summarizing', chunk: i + 1, total: chunks.length });

        const chatCompletion = await callGroqWithRetry([
            {
                role: "system",
                content: "You are summarizing a PART of a YouTube video transcript. Provide key points and important details. IMPORTANT: Do not use HTML tags like <br> or <div>. Always use standard Markdown and ensure the summary is in English."
            },
            {
                role: "user",
                content: chunks[i]
            }
        ], 2048);

        partialSummaries.push(chatCompletion.choices[0]?.message?.content || "");
    }

    let summary;
    if (partialSummaries.length > 1) {
        await job.updateProgress({ stage: 'merging' });
        await sleep(RATE_LIMIT_DELAY_MS);

        const finalCompletion = await callGroqWithRetry([
            {
                role: "system",
                content: "You are a professional assistant. Merge these summaries into a single, cohesive, highly structured final report in English. IMPORTANT: Do NOT use any HTML tags (like <br>). Use only standard Markdown. If you need multiple lines in a table cell or bullet point, use Markdown newlines or separate bullets."
            },
            {
                role: "user",
                content: `Combine these partial summaries into one final summary:\n\n${partialSummaries.join("\n\n---\n\n")}`
            }
        ], 4096);

        summary = finalCompletion.choices[0]?.message?.content;
    } else {
        summary = partialSummaries[0];
    }

    return summary;
}

// ─── BullMQ Worker ────────────────────────────────────────────
const worker = new Worker(
    'summarize',
    async (job) => {
        console.log(`[Worker] Processing job ${job.id} for video: ${job.data.videoUrl || 'unknown'}`);
        const summary = await summarizeChunks(job.data.transcript, job);
        console.log(`[Worker] Job ${job.id} completed.`);
        return { summary };
    },
    {
        connection: process.env.REDIS_URL
            ? {
                url: process.env.REDIS_URL,
                tls: { rejectUnauthorized: false }
            }
            : {
                host: process.env.REDIS_HOST || '127.0.0.1',
                port: parseInt(process.env.REDIS_PORT || '6379'),
            },
        concurrency: 1,
        limiter: {
            max: 1,
            duration: RATE_LIMIT_DELAY_MS,
        },
    }
);

worker.on('completed', (job) => {
    console.log(`[Worker] Job ${job.id} finished successfully.`);
});

worker.on('failed', (job, err) => {
    console.error(`[Worker] Job ${job?.id} failed:`, err.message);
});

worker.on('error', (err) => {
    console.error('[Worker] Error:', err.message);
});

console.log('[Worker] Summarize worker started and waiting for jobs...');
