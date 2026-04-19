const logger = require('./logger');

/**
 * Mantém um título em `payables` para cada lançamento bancário classificado com saída (valor < 0),
 * para o DRE e Contas a pagar refletirem o extrato.
 */
async function syncPayableFromBankEntry(supabase, { companyId, userId, entryId }) {
  const { data: entry, error } = await supabase
    .from('bank_entries')
    .select('id,company_id,amount,description,entry_date,category_id,payable_id,status')
    .eq('id', entryId)
    .eq('company_id', companyId)
    .maybeSingle();

  if (error || !entry) return { ok: false, error: error?.message };
  if (entry.status !== 'classified' || !entry.category_id) return { ok: true };

  const amt = Number(entry.amount);
  if (!Number.isFinite(amt) || amt >= 0) return { ok: true };

  const amountAbs = Math.round(Math.abs(amt) * 100) / 100;
  const desc = String(entry.description || 'Movimentação bancária').slice(0, 300);
  const due = entry.entry_date;

  if (entry.payable_id) {
    const { error: uErr } = await supabase
      .from('payables')
      .update({
        category_id: entry.category_id,
        amount: amountAbs,
        description: desc,
        due_date: due,
      })
      .eq('id', entry.payable_id)
      .eq('company_id', companyId);
    if (uErr) logger.error('bankPayableSync update', uErr.message);
    return { ok: !uErr, error: uErr?.message };
  }

  const { data: pay, error: insErr } = await supabase
    .from('payables')
    .insert({
      company_id: companyId,
      category_id: entry.category_id,
      description: desc,
      amount: amountAbs,
      due_date: due,
      origin: 'bank',
      origin_id: entry.id,
      status: 'open',
      created_by: userId || null,
      notes: 'Gerado pela conciliação bancária',
    })
    .select('id')
    .single();

  if (insErr) {
    logger.error('bankPayableSync insert', insErr.message);
    return { ok: false, error: insErr.message };
  }

  const { error: linkErr } = await supabase
    .from('bank_entries')
    .update({ payable_id: pay.id })
    .eq('id', entry.id)
    .eq('company_id', companyId);

  if (linkErr) logger.error('bankPayableSync link', linkErr.message);
  return { ok: !linkErr, error: linkErr?.message };
}

module.exports = { syncPayableFromBankEntry };
