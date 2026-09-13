#!/usr/bin/env node

import { createCli } from './cli/index.js';

const program = createCli();
program.parseAsync(process.argv).catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
