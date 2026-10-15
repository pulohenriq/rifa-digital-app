/**
 * Configuração do site (pública: pode ficar no GitHub).
 * NUNCA coloque a senha do administrador neste arquivo.
 *
 * API_URL          → endereço do Worker de cache da Cloudflare.
 * API_URL_RESERVA  → URL do Apps Script. Se o Worker falhar, o site usa esta sozinho.
 */
window.RIFA_CONFIG = {
  API_URL: 'https://rifa-api.sistema-ph.workers.dev',
  API_URL_RESERVA: 'https://script.google.com/macros/s/AKfycbyWGRwa3deUNNdmTdW0epgTChCI38vYvjZGon97CPUmUWwLNDx32A5WmuL4iAH3bi9-ng/exec'
};
