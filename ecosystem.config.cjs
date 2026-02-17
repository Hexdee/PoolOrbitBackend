module.exports = {
  apps: [
    {
      name: 'poolorbit-api',
      cwd: __dirname,
      script: 'npm',
      args: 'run start',
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'poolorbit-indexer',
      cwd: __dirname,
      script: 'npm',
      args: 'run indexer:run',
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
