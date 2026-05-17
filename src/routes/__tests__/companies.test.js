const express = require('express');
const request = require('supertest');

jest.mock('../../db', () => ({
  from: jest.fn(),
}));

jest.mock('../../middlewares/auth', () => ({
  authenticate: (req, res, next) => next(),
  requireAdmin: (req, res, next) => next(),
  requireCompanyAccess: (req, res, next) => next(),
}));

const supabase = require('../../db');
const companiesRouter = require('../companies');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/companies', companiesRouter);
  return app;
}

describe('GET /api/companies/active-restaurants', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('retorna label "12+ Restaurantes ativos" quando quantidade é 12 ou maior', async () => {
    const eq = jest.fn().mockResolvedValue({ count: 15, error: null });
    const select = jest.fn(() => ({ eq }));
    supabase.from.mockReturnValue({ select });
    const app = buildApp();

    const response = await request(app).get('/api/companies/active-restaurants');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      active_restaurants: 15,
      label: '12+ Restaurantes ativos',
    });
    expect(supabase.from).toHaveBeenCalledWith('companies');
    expect(select).toHaveBeenCalledWith('id', { count: 'exact', head: true });
    expect(eq).toHaveBeenCalledWith('active', true);
  });

  test('retorna valor exato quando quantidade é menor que 12', async () => {
    const eq = jest.fn().mockResolvedValue({ count: 7, error: null });
    const select = jest.fn(() => ({ eq }));
    supabase.from.mockReturnValue({ select });
    const app = buildApp();

    const response = await request(app).get('/api/companies/active-restaurants');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      active_restaurants: 7,
      label: '7 Restaurantes ativos',
    });
  });
});
