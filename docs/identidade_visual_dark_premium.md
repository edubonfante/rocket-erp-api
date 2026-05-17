# Design System - Identidade Visual Dark Premium

## 1) Essencia da marca
- **Posicionamento:** sofisticado, tecnologico e confiavel.
- **Personalidade:** discreta, objetiva e segura.
- **Percepcao alvo:** produto premium para operacao financeira de alto controle.

## 2) Fundacao visual
### Paleta principal
- `obsidian_950`: `#06080D` (fundo base)
- `obsidian_900`: `#0D111A` (fundo elevado)
- `obsidian_850`: `#111827` (cards e paines)
- `graphite_700`: `#2A3344` (bordas suaves)
- `silver_300`: `#A5B0C2` (texto secundario)
- `snow_050`: `#F5F7FB` (texto principal em destaque)

### Acentos premium
- `gold_500`: `#D6B25E` (acoes premium e destaques)
- `gold_400`: `#E4C878` (hover / brilho)
- `cyan_500`: `#32C5FF` (dados ativos e links)
- `success_500`: `#2EC98A`
- `warning_500`: `#F3B63F`
- `danger_500`: `#EF5A6F`

### Gradientes recomendados
- `premium_surface`: `linear-gradient(135deg, #0D111A 0%, #131A27 60%, #1B2231 100%)`
- `premium_gold_line`: `linear-gradient(90deg, rgba(214,178,94,0) 0%, rgba(214,178,94,0.8) 50%, rgba(214,178,94,0) 100%)`

## 3) Tipografia
- **Titulos:** `Manrope` (ou `Inter` fallback), peso 600-700, tracking levemente fechado.
- **Texto:** `Inter`, pesos 400-500 para leitura continua.
- **Numeros financeiros:** `IBM Plex Sans` ou `Inter tabular-nums`.

Escala sugerida:
- Display: 40/48
- H1: 32/40
- H2: 24/32
- H3: 20/28
- Body L: 16/24
- Body M: 14/20
- Caption: 12/16

## 4) Principios de UI
- Fundo sempre escuro e limpo; evitar ruido visual.
- Contraste minimo `WCAG AA`.
- Brilho dourado usado com moderacao (nao usar em excesso).
- Bordas com baixa opacidade para separar superficies sem "grid pesado".
- Estados interativos claros: `default`, `hover`, `focus`, `active`, `disabled`.

## 5) Componentes chave
### Botao primario
- Fundo: `gold_500`
- Texto: `#0A0D14`
- Hover: `gold_400`
- Focus ring: `0 0 0 3px rgba(214,178,94,0.35)`

### Botao secundario
- Fundo: `transparent`
- Borda: `1px solid #2A3344`
- Texto: `snow_050`
- Hover: `#111827`

### Cards
- Fundo: `obsidian_900`
- Borda: `1px solid rgba(165,176,194,0.14)`
- Sombra: `0 10px 30px rgba(0,0,0,0.35)`
- Radius: `14px`

### Inputs
- Fundo: `#0F1522`
- Borda: `1px solid #2A3344`
- Texto: `#F5F7FB`
- Placeholder: `#6B7485`
- Focus: borda `gold_500` + glow suave

## 6) Tokens CSS (prontos para implementacao)
```css
:root {
  --bg-app: #06080D;
  --bg-surface: #0D111A;
  --bg-card: #111827;
  --border-soft: rgba(165, 176, 194, 0.14);
  --text-primary: #F5F7FB;
  --text-secondary: #A5B0C2;
  --accent-gold: #D6B25E;
  --accent-gold-hover: #E4C878;
  --accent-cyan: #32C5FF;
  --success: #2EC98A;
  --warning: #F3B63F;
  --danger: #EF5A6F;
  --radius-md: 10px;
  --radius-lg: 14px;
  --shadow-premium: 0 10px 30px rgba(0,0,0,0.35);
}
```

## 7) Iconografia e imagem
- Icones em linha fina (1.5px a 2px), cantos levemente arredondados.
- Uso de blur/vidro somente em elementos de destaque.
- Fotos (quando houver): baixo brilho, alto contraste, tons frios.

## 8) Motion
- Duracao curta e elegante:
  - hover/focus: `120ms` ease-out
  - expand/collapse: `180ms` ease-in-out
  - transicao de pagina: `220ms` cubic-bezier(0.22, 1, 0.36, 1)
- Evitar animacoes longas e chamativas.

## 9) Aplicacao pratica no produto
- Dashboard: fundos escuros com metricas em alto contraste.
- Tabelas: linhas sutis, destaque de hover com `obsidian_850`.
- KPIs financeiros: usar `gold_500` para total consolidado e `cyan_500` para series ativas.
- Alertas: manter cores sem saturacao extrema para preservar premium feel.

## 10) Checklist de consistencia
- [ ] Contraste validado para textos e elementos interativos.
- [ ] Acento dourado aplicado somente em CTAs e destaques.
- [ ] Bordas e sombras consistentes em todos os cards.
- [ ] Escala tipografica respeitada.
- [ ] Estados de foco visiveis para acessibilidade.

