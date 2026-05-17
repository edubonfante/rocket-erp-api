const express = require('express');
const request = require('supertest');

const privacyRoutes = require('../privacy');

describe('privacy routes', () => {
  function makeApp() {
    const app = express();
    app.use('/', privacyRoutes);
    return app;
  }

  test('GET /privacidade returns LGPD privacy policy page', async () => {
    const app = makeApp();
    const response = await request(app).get('/privacidade');

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/html/);
    expect(response.text).toContain('Politica de Privacidade (LGPD)');
    expect(response.text).toContain('Lei Geral de Protecao de Dados');
  });
});
