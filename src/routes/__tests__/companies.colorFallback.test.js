const express = require('express');
const request = require('supertest');

jest.mock('../../db', () => ({ from: jest.fn() }));
jest.mock('../../middlewares/auth', () => {
  const pass = (req, _res, next) => {
    req.companyId = req.params.companyId || req.params.id || req.companyId;
    req.user = req.user || { id: 'user-1', role: 'admin' };
    next();
  };
  return {
    authenticate: pass,
    requireAdmin: pass,
    requireCompanyAccess: pass,
  };
});

const supabase = require('../../db');
const companiesRouter = require('../companies');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/companies', companiesRouter);
  return app;
}

describe('companies category color fallback', () => {
  beforeEach(() => {
    supabase.from.mockReset();
  });

  test('POST /companies/:id/categories applies off-white default color', async () => {
    const insertMock = jest.fn().mockReturnValue({
      select: jest.fn().mockReturnValue({
        single: jest.fn().mockResolvedValue({
          data: { id: 'cat-1', name: 'Nova', color: '#f5f4f0', type: 'despesa' },
          error: null,
        }),
      }),
    });
    supabase.from.mockReturnValue({ insert: insertMock });

    const app = createApp();
    const res = await request(app)
      .post('/companies/comp-1/categories')
      .send({ name: 'Nova categoria' });

    expect(res.status).toBe(201);
    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(insertMock.mock.calls[0][0]).toMatchObject({
      company_id: 'comp-1',
      name: 'Nova categoria',
      color: '#f5f4f0',
    });
  });

  test('PATCH /companies/:id/categories/:catId uses off-white fallback on empty color', async () => {
    const firstChain = {
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { id: 'cat-1', company_id: 'comp-1' },
        error: null,
      }),
    };

    const updateMock = jest.fn().mockReturnThis();
    const secondChain = {
      update: updateMock,
      eq: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      single: jest.fn().mockResolvedValue({
        data: { id: 'cat-1', color: '#f5f4f0', company_id: 'comp-1' },
        error: null,
      }),
    };

    supabase.from
      .mockReturnValueOnce(firstChain)
      .mockReturnValueOnce(secondChain);

    const app = createApp();
    const res = await request(app)
      .patch('/companies/comp-1/categories/cat-1')
      .send({ color: '' });

    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ color: '#f5f4f0' }),
    );
  });
});
