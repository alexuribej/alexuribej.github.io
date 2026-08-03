export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    if (request.method !== 'POST') {
      return new Response(JSON.stringify({error: 'Method not allowed'}), {
        status: 405,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    try {
      const body = await request.json();
      const { url, imageBase64, imageMediaType } = body;

      const content = [];

      if (imageBase64 && imageMediaType) {
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: imageMediaType,
            data: imageBase64,
          }
        });
      }

      content.push({
        type: 'text',
        text: `Eres un experto en tecnología. Analiza este producto desde la URL: ${url}. Genera una ficha técnica profesional en español con especificaciones técnicas detalladas, características principales y usos recomendados.`
      });

      const apiResponse = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-6',
          max_tokens: 2048,
          messages: [{ role: 'user', content }]
        })
      });

      const data = await apiResponse.json();

      if (data.error) {
        return new Response(JSON.stringify({
          content: [{ text: `Error de API: ${data.error.message}` }]
        }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }

      return new Response(JSON.stringify(data), {
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });

    } catch (error) {
      return new Response(JSON.stringify({
        content: [{ text: `Error: ${error.message}` }]
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
  }
};
