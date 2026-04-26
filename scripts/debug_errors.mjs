import { evaluate } from '../src/connection.js';
import { getErrors } from '../src/core/pine.js';

const errs = await getErrors();
console.log('Pine errors:', JSON.stringify(errs, null, 2));
