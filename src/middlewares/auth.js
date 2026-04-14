const jwt = require('jsonwebtoken');
const supabase = require('../db');

// Verifica JWT e injeta req.user
async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer '))
      return res.status(401).json({ error: 'Token não fornecido' });

    const token = authHeader.split(' ')[1];
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // Busca usuário atual no banco (valida se ainda está ativo)
    const { data: user, error } = await supabase
      .from('users')
      .select('id, name, email, role, active')
      .eq('id', payload.sub)
      .single();

    if (error || !user || !user.active)
      return res.status(401).json({ error: 'Usuário inválido ou inativo' });

    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError')
      return res.status(401).json({ error: 'Token expirado. Faça login novamente.' });
    return res.status(401).json({ error: 'Token inválido' });
  }
}

// Verifica se é admin
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin')
    return res.status(403).json({ error: 'Acesso negado. Requer perfil Administrador.' });
  next();
}

// Verifica se tem acesso à empresa solicitada
async function requireCompanyAccess(req, res, next) {
  const companyId = req.params.companyId || req.body.companyId || req.query.companyId;
  if (!companyId) return res.status(400).json({ error: 'company_id obrigatório' });

  if (req.user.role === 'admin') {
    req.companyId = companyId;
    return next();
  }

  const { data } = await supabase
    .from('user_companies')
    .select('company_id')
    .eq('user_id', req.user.id)
    .eq('company_id', companyId)
    .single();

  if (!data) return res.status(403).json({ error: 'Sem acesso a esta empresa.' });
  req.companyId = companyId;
  next();
}

// Verifica permissão de módulo
function requirePermission(module) {
  return async (req, res, next) => {
    if (req.user.role === 'admin') return next();

    const { data } = await supabase
      .from('user_permissions')
      .select('can_view')
      .eq('user_id', req.user.id)
      .eq('module', module)
      .single();

    if (!data?.can_view)
      return res.status(403).json({ error: `Sem permissão para o módulo: ${module}` });
    next();
  };
}

module.exports = { authenticate, requireAdmin, requireCompanyAccess, requirePermission };
