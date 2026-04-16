module.exports = {
  apps: [{
    name: 'forge-runner',
    script: 'dist/index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '512M',
    error_file: './logs/error.log',
    out_file: './logs/out.log',
  }]
}
