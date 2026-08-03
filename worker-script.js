export default {
  async fetch(request, env) {
    const headers = {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers });
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
    }

    try {
      const body = await request.json();
      const prompt = body.messages?.[0]?.content || '';
      const rawUrl = body.url || prompt.match(/https?:\/\/[^\s)]+/)?.[0];
      if (!rawUrl) return new Response(JSON.stringify({ error: 'No se recibió una URL' }), { status: 400, headers });

      const productUrl = new URL(rawUrl);
      if (!['http:', 'https:'].includes(productUrl.protocol) || /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(productUrl.hostname)) {
        return new Response(JSON.stringify({ error: 'URL no válida' }), { status: 400, headers });
      }

      let pageText = '';
      let imageUrl = '';
      try {
        const page = await fetch(productUrl, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; GrupoAlferaFicha/1.0)',
            'Accept': 'text/html,application/xhtml+xml',
          },
        });
        const html = await page.text();
        const image =
          html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
          html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i) ||
          html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);
        if (image?.[1]) imageUrl = new URL(image[1], productUrl).toString();
        pageText = html
          .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .slice(0, 12000);
      } catch {
        // Algunas tiendas bloquean la lectura; la ficha sigue funcionando sin foto.
      }

      const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 2048,
          messages: [{
            role: 'user',
            content: `${prompt}\n\nDatos extraídos de la página:\n${pageText || 'No se pudo leer la página; usa la URL y el modelo.'}`,
          }],
        }),
      });

      const data = await apiResponse.json();
      if (data.error) {
        return new Response(JSON.stringify({ content: [{ text: `Error de API: ${data.error.message}` }] }), {
          status: apiResponse.status,
          headers,
        });
      }

      return new Response(JSON.stringify({ ...data, imageUrl }), { headers });
    } catch (error) {
      return new Response(JSON.stringify({ content: [{ text: `Error: ${error.message}` }] }), {
        status: 500,
        headers,
      });
    }
  },
};
