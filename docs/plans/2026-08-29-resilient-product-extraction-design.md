# Diseño: extracción resiliente de fichas técnicas

## Objetivo

El Worker debe producir una ficha siempre que al menos uno de los proveedores de IA esté operativo. La extracción limpia seguirá siendo el camino rápido; cuando pierda información o genere una respuesta inválida, el sistema volverá a intentarlo utilizando el HTML renderizado bruto.

## Flujo aprobado

1. Obtener la página mediante Browser Run.
2. Si Browser Run falla, intentar `fetch` HTTP.
3. Generar una ficha con el texto visible limpio.
4. Validar estructura y riqueza mínima de la ficha.
5. Si el resultado es inválido o insuficiente, procesar el HTML bruto.
6. Si el HTML no cabe en una petición, dividirlo en fragmentos, extraer evidencia de todos y consolidarla en una ficha estructurada.
7. Si DeepSeek no produce una ficha válida, repetir el flujo con Anthropic.
8. Si ningún método obtuvo HTML, pedir la ficha usando la URL como contexto.
9. Aplicar únicamente correcciones posteriores respaldadas por evidencia explícita del producto.

## Reintentos

- Reintentar una vez errores de red, `408`, `429` y `5xx`, con una espera breve.
- No reintentar `400`, `401`, `402` o `403`; cambiar inmediatamente de proveedor.
- Una respuesta JSON inválida o incompleta activa el fallback con HTML bruto.
- El último resultado válido se devuelve aunque su nivel de detalle sea inferior al deseado; nunca se sustituye por una ficha genérica fabricada localmente.

## HTML bruto y fragmentación

- Conservar el HTML renderizado original como fuente del fallback.
- Dividirlo por tamaño sin interpretar su contenido.
- Cada fragmento se envía como contenido no confiable y el modelo debe ignorar cualquier instrucción presente en la página.
- Los resúmenes factuales de todos los fragmentos se consolidan en una única generación con el mismo esquema JSON.
- Se eliminan únicamente secuencias binarias `data:` de gran tamaño para evitar desperdiciar contexto; no se elimina contenido textual del producto.

## Calidad

Una ficha rápida se considera suficiente cuando:

- supera la validación del esquema;
- contiene al menos tres especificaciones rápidas;
- contiene al menos tres filas técnicas entre sus secciones.

Si no alcanza ese umbral pero es válida, se conserva como candidato y se intenta mejorar con HTML bruto. Si todos los fallbacks posteriores fallan, se devuelve ese candidato válido en lugar de un error.

## Observabilidad

Cada respuesta incluirá:

- identificador de petición;
- proveedor utilizado;
- método (`clean_text`, `raw_html`, `raw_html_chunks` o `url_only`);
- número de fragmentos;
- avisos no sensibles de proveedores fallidos.

Los mismos campos se registrarán en Cloudflare sin incluir API keys ni el HTML recibido.

## Pruebas

- Camino rápido válido.
- Camino rápido válido pero insuficiente.
- JSON inválido que activa HTML bruto.
- HTML mayor que un fragmento y consolidación correcta.
- `429`, timeout y `5xx` con reintento.
- Error de saldo/autenticación sin reintento y cambio de proveedor.
- Browser Run bloqueado con fallback HTTP.
- Ambos métodos de página bloqueados con fallback por URL.
- DeepSeek fallando y Anthropic completando la ficha.
- Conservación de un candidato válido cuando las mejoras fallan.
- Regresión de productos nuevos mencionados junto a reacondicionados.

## Límite real

No puede garantizarse una ficha si todos los proveedores de IA están simultáneamente caídos, sin saldo o mal configurados. El sistema sí garantizará que cualquier ficha válida obtenida en un intento anterior se conserve y se devuelva.
