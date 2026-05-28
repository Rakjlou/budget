import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { basicAuth } from './auth.js';
import {
  listPeriods,
  createPeriod,
  getCurrentPeriod,
  getPeriod,
  updatePeriod,
} from './periods.js';
import {
  listCurrentExpenses,
  createCurrentExpense,
  listExpensesByPeriod,
  getExpense,
  updateExpense,
  deleteExpense,
} from './expenses.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const apiSpecPath = path.resolve(__dirname, '../openapi.yaml');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const isDev = process.env.NODE_ENV !== 'production';

const app = express();

app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(
      `${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`
    );
  });
  next();
});

app.use(express.json());

app.get('/openapi.yaml', (req, res) => {
  res.type('application/yaml').sendFile(apiSpecPath);
});

app.use('/api/v1', basicAuth);

app.use(
  OpenApiValidator.middleware({
    apiSpec: apiSpecPath,
    validateRequests: true,
    validateResponses: isDev,
    validateSecurity: false,
  })
);

const api = express.Router();
api.get('/periods', listPeriods);
api.post('/periods', createPeriod);
api.get('/periods/current', getCurrentPeriod);
api.get('/periods/current/expenses', listCurrentExpenses);
api.post('/periods/current/expenses', createCurrentExpense);
api.get('/periods/:id', getPeriod);
api.patch('/periods/:id', updatePeriod);
api.get('/periods/:id/expenses', listExpensesByPeriod);
api.get('/expenses/:id', getExpense);
api.patch('/expenses/:id', updateExpense);
api.delete('/expenses/:id', deleteExpense);

app.use('/api/v1', api);

app.use((req, res) => {
  res.status(404).json({
    error: 'not_found',
    message: `Route ${req.method} ${req.originalUrl} not found`,
  });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;

  if (status >= 500) {
    console.error(err);
    return res.status(500).json({
      error: 'internal_error',
      message: 'Internal server error',
    });
  }

  let code = 'client_error';
  if (status === 400) code = 'validation_failed';
  else if (status === 401) code = 'unauthorized';
  else if (status === 404) code = 'not_found';
  else if (status === 409) code = 'conflict';

  if (status === 401) {
    res.set('WWW-Authenticate', 'Basic realm="budget-tracker"');
  }

  const body = { error: code, message: err.message };
  if (Array.isArray(err.errors) && err.errors.length) body.details = err.errors;
  res.status(status).json(body);
});

const isMain = import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  app.listen(PORT, HOST, () => {
    console.log(`Budget Tracker listening on http://${HOST}:${PORT}`);
  });
}

export { app };
