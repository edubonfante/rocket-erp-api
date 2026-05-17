const menu = [
  { label: "Módulos", href: "#modulos" },
  { label: "Benefícios", href: "#beneficios" },
  { label: "Planos", href: "#planos" },
  { label: "FAQ", href: "#faq" },
  { label: "Contato", href: "#contato" },
];

const modules = [
  {
    icon: "💳",
    title: "Financeiro inteligente",
    description:
      "Fluxo de caixa, contas a pagar/receber, conciliação bancária e DRE em tempo real.",
  },
  {
    icon: "🧾",
    title: "Fiscal e documentos",
    description:
      "Emissão e armazenamento de NF-e, controle de XML e relatórios para contabilidade.",
  },
  {
    icon: "📦",
    title: "Estoque e compras",
    description:
      "Entrada, saída, inventário e compras conectados ao financeiro e às vendas.",
  },
  {
    icon: "📈",
    title: "Vendas e CRM",
    description:
      "Pipeline comercial, propostas, pedidos e indicadores de conversão por equipe.",
  },
  {
    icon: "🤝",
    title: "Times integrados",
    description:
      "Permissões por perfil, aprovações e históricos completos para cada processo.",
  },
  {
    icon: "⚙️",
    title: "Automação operacional",
    description:
      "Rotinas automatizadas para cobranças, alertas, tarefas e acompanhamento diário.",
  },
];

const benefits = [
  "Implementação simples com suporte especializado.",
  "Visão unificada da operação para decisões rápidas.",
  "Relatórios executivos para diretoria e financeiro.",
  "Escalável para empresas em crescimento acelerado.",
];

const testimonials = [
  {
    quote:
      "Com o Rocket ERP reduzimos em 42% o tempo de fechamento mensal e ganhamos previsibilidade de caixa.",
    author: "Fernanda Souza",
    role: "CFO, Atlas Distribuidora",
  },
  {
    quote:
      "Nossa operação comercial ficou transparente. Hoje sabemos exatamente onde cada oportunidade está.",
    author: "Marcos Almeida",
    role: "Diretor Comercial, Nexa Serviços",
  },
  {
    quote:
      "A integração entre estoque, fiscal e financeiro acabou com retrabalho e retrata nossa operação real.",
    author: "Camila Ribeiro",
    role: "COO, Horizonte Tech",
  },
];

const faqs = [
  {
    question: "O Rocket ERP atende quais segmentos?",
    answer:
      "Atendemos serviços, comércio e indústria leve. O onboarding é adaptado para a realidade de cada operação.",
  },
  {
    question: "Quanto tempo leva para implantar?",
    answer:
      "A média varia de 2 a 6 semanas, dependendo do volume de dados, integrações necessárias e maturidade dos processos.",
  },
  {
    question: "Existe suporte no pós-implantação?",
    answer:
      "Sim. Todos os planos incluem suporte, base de conhecimento e acompanhamento de evolução com nosso time de sucesso.",
  },
  {
    question: "O site é separado do sistema?",
    answer:
      "Sim. Este site institucional é independente do app operacional e direciona para o acesso em ambiente dedicado.",
  },
];

export default function Home() {
  return (
    <div className="text-slate-100">
      <header className="sticky top-0 z-50 border-b border-slate-800/70 bg-slate-950/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
          <a href="#inicio" className="flex items-center gap-2 text-lg font-semibold">
            <span className="rounded bg-rose-500 px-2 py-1 text-sm font-bold">Rocket</span>
            <span>ERP</span>
          </a>
          <nav className="hidden items-center gap-6 text-sm text-slate-300 md:flex">
            {menu.map((item) => (
              <a key={item.href} href={item.href} className="transition hover:text-white">
                {item.label}
              </a>
            ))}
          </nav>
          <a
            href="https://rocketrocket-64c29.web.app"
            target="_blank"
            rel="noreferrer"
            className="rounded-full border border-rose-400/60 px-4 py-2 text-sm font-medium text-rose-100 transition hover:bg-rose-500 hover:text-white"
          >
            Entrar no app
          </a>
        </div>
      </header>

      <main id="inicio">
        <section className="mx-auto max-w-6xl px-6 pb-20 pt-16 sm:pt-24">
          <div className="grid items-center gap-12 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="space-y-8">
              <span className="inline-flex rounded-full border border-rose-400/40 bg-rose-500/10 px-4 py-1 text-sm font-medium text-rose-200">
                Plataforma de gestão para PMEs que querem escala
              </span>
              <h1 className="text-balance text-4xl font-bold leading-tight text-white sm:text-5xl">
                Controle toda a empresa em um único ERP, sem planilhas e sem retrabalho.
              </h1>
              <p className="max-w-2xl text-lg text-slate-300">
                O Rocket ERP centraliza financeiro, vendas, estoque e fiscal para sua equipe
                operar com velocidade e previsibilidade.
              </p>
              <div className="flex flex-wrap gap-4">
                <a
                  href="#contato"
                  className="rounded-full bg-rose-500 px-6 py-3 text-sm font-semibold text-white transition hover:bg-rose-400"
                >
                  Agendar demonstração
                </a>
                <a
                  href="#modulos"
                  className="rounded-full border border-slate-600 px-6 py-3 text-sm font-semibold text-slate-200 transition hover:border-slate-400 hover:text-white"
                >
                  Ver funcionalidades
                </a>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-900/70 p-6 shadow-2xl shadow-slate-950/40">
              <p className="mb-4 text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
                Indicadores em destaque
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                  <p className="text-2xl font-bold text-white">+220</p>
                  <p className="text-sm text-slate-400">empresas em operação</p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                  <p className="text-2xl font-bold text-white">98.9%</p>
                  <p className="text-sm text-slate-400">uptime médio anual</p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                  <p className="text-2xl font-bold text-white">-37%</p>
                  <p className="text-sm text-slate-400">tempo de fechamento mensal</p>
                </div>
                <div className="rounded-xl border border-slate-800 bg-slate-950/70 p-4">
                  <p className="text-2xl font-bold text-white">+18h</p>
                  <p className="text-sm text-slate-400">economizadas por semana</p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section id="modulos" className="border-y border-slate-800/80 bg-slate-900/50 py-20">
          <div className="mx-auto max-w-6xl px-6">
            <h2 className="text-3xl font-bold text-white">Módulos que conectam sua operação</h2>
            <p className="mt-3 max-w-3xl text-slate-300">
              Tudo o que sua empresa precisa para crescer com segurança, integração e dados
              confiáveis para tomada de decisão.
            </p>
            <div className="mt-10 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
              {modules.map((module) => (
                <article
                  key={module.title}
                  className="rounded-2xl border border-slate-800 bg-slate-950/80 p-6 transition hover:-translate-y-1 hover:border-slate-600"
                >
                  <p className="text-2xl">{module.icon}</p>
                  <h3 className="mt-4 text-lg font-semibold text-white">{module.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-slate-300">
                    {module.description}
                  </p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section id="beneficios" className="mx-auto max-w-6xl px-6 py-20">
          <div className="grid gap-10 lg:grid-cols-2">
            <div>
              <h2 className="text-3xl font-bold text-white">
                Porque empresas escolhem o Rocket ERP
              </h2>
              <p className="mt-4 text-slate-300">
                Mais do que software: entregamos método de gestão, acompanhamento e evolução
                contínua para que sua empresa cresça com base em dados reais.
              </p>
              <ul className="mt-8 space-y-4">
                {benefits.map((benefit) => (
                  <li key={benefit} className="flex items-start gap-3 text-slate-200">
                    <span className="mt-1 rounded-full bg-emerald-500/20 px-2 text-emerald-300">
                      ✓
                    </span>
                    <span>{benefit}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="space-y-4 rounded-2xl border border-slate-800 bg-slate-900/70 p-8">
              <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
                Jornada de implantação
              </p>
              <div className="space-y-4">
                {[
                  "Diagnóstico completo da operação atual.",
                  "Configuração dos módulos e regras do negócio.",
                  "Migração de dados e integrações prioritárias.",
                  "Treinamento do time e entrada em produção.",
                ].map((step, index) => (
                  <div key={step} className="flex gap-3 border-b border-slate-800 pb-4 last:border-0">
                    <span className="h-6 w-6 rounded-full bg-rose-500 text-center text-sm font-bold text-white">
                      {index + 1}
                    </span>
                    <p className="text-sm text-slate-300">{step}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        <section className="border-y border-slate-800/80 bg-slate-900/40 py-20">
          <div className="mx-auto max-w-6xl px-6">
            <h2 className="text-3xl font-bold text-white">Resultados de quem já usa</h2>
            <div className="mt-10 grid gap-5 lg:grid-cols-3">
              {testimonials.map((testimonial) => (
                <blockquote
                  key={testimonial.author}
                  className="rounded-2xl border border-slate-800 bg-slate-950/70 p-6"
                >
                  <p className="text-slate-200">&quot;{testimonial.quote}&quot;</p>
                  <footer className="mt-6 border-t border-slate-800 pt-4">
                    <p className="font-semibold text-white">{testimonial.author}</p>
                    <p className="text-sm text-slate-400">{testimonial.role}</p>
                  </footer>
                </blockquote>
              ))}
            </div>
          </div>
        </section>

        <section id="planos" className="mx-auto max-w-6xl px-6 py-20">
          <h2 className="text-3xl font-bold text-white">Planos para cada estágio da empresa</h2>
          <p className="mt-3 max-w-2xl text-slate-300">
            Comece com o essencial e evolua conforme sua operação exige mais automação e controle.
          </p>
          <div className="mt-10 grid gap-5 lg:grid-cols-3">
            {[
              {
                name: "Start",
                price: "Sob consulta",
                features: [
                  "Financeiro + Vendas",
                  "Usuários ilimitados",
                  "Suporte padrão",
                  "Dashboard executivo",
                ],
              },
              {
                name: "Growth",
                price: "Sob consulta",
                featured: true,
                features: [
                  "Tudo do Start",
                  "Fiscal e Estoque",
                  "Automação de cobranças",
                  "Suporte prioritário",
                ],
              },
              {
                name: "Enterprise",
                price: "Personalizado",
                features: [
                  "Tudo do Growth",
                  "Integrações avançadas",
                  "Implantação dedicada",
                  "Gestor de conta",
                ],
              },
            ].map((plan) => (
              <article
                key={plan.name}
                className={`rounded-2xl border p-6 ${
                  plan.featured
                    ? "border-rose-400 bg-rose-500/10"
                    : "border-slate-800 bg-slate-900/50"
                }`}
              >
                <h3 className="text-xl font-semibold text-white">{plan.name}</h3>
                <p className="mt-2 text-slate-200">{plan.price}</p>
                <ul className="mt-6 space-y-2 text-sm text-slate-300">
                  {plan.features.map((feature) => (
                    <li key={feature}>• {feature}</li>
                  ))}
                </ul>
                <a
                  href="#contato"
                  className="mt-6 inline-block rounded-full bg-white px-5 py-2 text-sm font-semibold text-slate-900 transition hover:bg-slate-200"
                >
                  Falar com especialista
                </a>
              </article>
            ))}
          </div>
        </section>

        <section id="faq" className="border-y border-slate-800/80 bg-slate-900/40 py-20">
          <div className="mx-auto max-w-4xl px-6">
            <h2 className="text-3xl font-bold text-white">Perguntas frequentes</h2>
            <div className="mt-8 space-y-3">
              {faqs.map((item) => (
                <details key={item.question} className="rounded-xl border border-slate-800 p-5">
                  <summary className="cursor-pointer font-medium text-white">
                    {item.question}
                  </summary>
                  <p className="mt-3 text-sm leading-relaxed text-slate-300">{item.answer}</p>
                </details>
              ))}
            </div>
          </div>
        </section>

        <section id="contato" className="mx-auto max-w-6xl px-6 py-20">
          <div className="rounded-3xl border border-slate-800 bg-slate-900/70 p-8 text-center sm:p-12">
            <p className="text-sm font-semibold uppercase tracking-[0.2em] text-slate-400">
              Pronto para evoluir a gestão?
            </p>
            <h2 className="mt-4 text-3xl font-bold text-white sm:text-4xl">
              Agende uma demonstração personalizada do Rocket ERP.
            </h2>
            <p className="mx-auto mt-4 max-w-2xl text-slate-300">
              Nosso time analisa seu cenário atual e apresenta um plano de implantação alinhado à
              sua operação.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-4">
              <a
                href="mailto:contato@rocketerp.com.br"
                className="rounded-full bg-rose-500 px-6 py-3 text-sm font-semibold text-white transition hover:bg-rose-400"
              >
                contato@rocketerp.com.br
              </a>
              <a
                href="https://rocketrocket-64c29.web.app"
                target="_blank"
                rel="noreferrer"
                className="rounded-full border border-slate-600 px-6 py-3 text-sm font-semibold text-slate-200 transition hover:border-slate-400 hover:text-white"
              >
                Abrir ambiente do sistema
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-slate-800 bg-slate-950 py-10">
        <div className="mx-auto flex max-w-6xl flex-col justify-between gap-4 px-6 text-sm text-slate-400 sm:flex-row sm:items-center">
          <p>© {new Date().getFullYear()} Rocket ERP. Todos os direitos reservados.</p>
          <div className="flex gap-5">
            <a href="#inicio" className="transition hover:text-slate-200">
              Início
            </a>
            <a href="#contato" className="transition hover:text-slate-200">
              Fale conosco
            </a>
            <a
              href="https://rocketrocket-64c29.web.app"
              target="_blank"
              rel="noreferrer"
              className="transition hover:text-slate-200"
            >
              App Rocket ERP
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
