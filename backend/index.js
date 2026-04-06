import express from 'express';
import cors from 'cors';
import { YoutubeTranscript } from 'youtube-transcript/dist/youtube-transcript.esm.js';
import { Groq } from 'groq-sdk';
import 'dotenv/config';

const groq = new Groq();

const app = express();
const port = process.env.PORT || 5001;

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type'],
}));
app.use(express.json());

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

const CHUNK_SIZE_CHARS = 8000; // Smaller chunks to be safer with token limits
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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

app.post('/api/summarize', async (req, res) => {
    try {
        const { transcript } = req.body;

        if (!transcript || !Array.isArray(transcript)) {
            return res.status(400).json({ error: 'Transcript data is required' });
        }

        const chunks = chunkTranscript(transcript);
        console.log(`Summarizing transcript in ${chunks.length} chunks...`);

        const partialSummaries = [];
        for (let i = 0; i < chunks.length; i++) {
            if (i > 0) {
                console.log(`Waiting 15 seconds before processing chunk ${i + 1}/${chunks.length}...`);
                await sleep(15000);
            }
            console.log(`Summarizing chunk ${i + 1}/${chunks.length}...`);
            const chatCompletion = await groq.chat.completions.create({
                "messages": [
                    {
                        "role": "system",
                        "content": "You are summarizing a PART of a YouTube video transcript. Provide key points and important details. IMPORTANT: Do not use HTML tags like <br> or <div>. Always use standard Markdown and ensure the summary is in English."
                    },
                    {
                        "role": "user",
                        "content": chunks[i]
                    }
                ],
                "model": "openai/gpt-oss-20b",
                "temperature": 1,
                "max_completion_tokens": 2048,
                "top_p": 1,
                "stream": false,
                "reasoning_effort": "medium"
            });
            partialSummaries.push(chatCompletion.choices[0]?.message?.content || "");
        }

        let summary;
        if (partialSummaries.length > 1) {
            console.log('Waiting 15 seconds before final merge...');
            await sleep(15000);
            console.log('Merging partial summaries into final summary...');
            const finalCompletion = await groq.chat.completions.create({
                "messages": [
                    {
                        "role": "system",
                        "content": "You are a professional assistant. Merge these summaries into a single, cohesive, highly structured final report in English. IMPORTANT: Do NOT use any HTML tags (like <br>). Use only standard Markdown. If you need multiple lines in a table cell or bullet point, use Markdown newlines or separate bullets."
                    },
                    {
                        "role": "user",
                        "content": `Combine these partial summaries into one final summary:\n\n${partialSummaries.join("\n\n---\n\n")}`
                    }
                ],
                "model": "openai/gpt-oss-20b",
                "temperature": 1,
                "max_completion_tokens": 4096,
                "top_p": 1,
                "stream": false,
                "reasoning_effort": "medium"
            });
            summary = finalCompletion.choices[0]?.message?.content;
        } else {
            summary = partialSummaries[0];
        }

        console.log('Summarization complete.');
        res.json({ summary });

    } catch (error) {
        console.error('Error summarizing:', error.response?.data || error.message);
        res.status(500).json({
            error: 'Failed to generate summary',
            details: error.response?.data?.message || (error.message.includes('413') ? 'Transcript is too large for the current AI tier. Refined chunking implemented.' : error.message)
        });
    }
});

const server = app.listen(port, () => {
    console.log(`Backend server running on http://localhost:${port}`);
});

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${port} is already in use. Try a different port.`);
    } else {
        console.error('Server error:', err);
    }
    process.exit(1);
});
