module.exports = {
    apps: [
        {
            name: 'yt-transcript-api',
            script: 'index.js',
            instances: 'max',       // Scales the API to use all available CPU cores
            exec_mode: 'cluster',   // Enables load balancing across cores
            env: {
                NODE_ENV: 'production',
            },
        },
        {
            name: 'yt-transcript-worker',
            script: 'summarizeWorker.js',
            instances: 1,           // Keep worker at 1 for strict Groq rate-limit compliance
            exec_mode: 'fork',
            env: {
                NODE_ENV: 'production',
            },
        },
    ],
};
