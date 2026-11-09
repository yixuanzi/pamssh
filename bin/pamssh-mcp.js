#!/usr/bin/env node
import { main } from '../src/cli.js';

const code = await main();
if (typeof code === 'number') process.exitCode = code;
