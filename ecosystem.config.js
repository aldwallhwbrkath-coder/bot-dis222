module.exports = {
    apps: [{
        name: 'bot-discord',
        script: './index.js',
        instances: 1,
        autorestart: true,
        watch: false,
        min_uptime: '10s',
        max_restarts: 1000,
        exp_backoff_restart_delay: 100,
        max_memory_restart: '300M',
        restart_delay: 5000,
        kill_timeout: 10000,
        env: {
            NODE_ENV: 'production'
        }
    }]
};