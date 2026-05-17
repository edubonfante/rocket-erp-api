const express = require('express');
const request = require('supertest');

const legalRoutes = require('../legal');

describe('legal routes', () => {
  test('GET /termos returns terms of use HTML page', async () => {
    const app = express();
    app.use('/', legalRoutes);

    const response = await request(app).get('/termos');

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/html/);
    expect(response.text).toContain('Termos de Uso');
    expect(response.text).toContain('Rocket ERP');
  });
});
