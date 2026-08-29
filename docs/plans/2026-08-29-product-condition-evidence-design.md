# Diseño: condición del producto basada en evidencia explícita

## Problema

El Worker puede convertir un producto `Nuevo` en `Reacondicionado` cuando esas palabras aparecen en recomendaciones, banners, scripts, datos de otros productos o parámetros de la URL. La causa es que `applyPageCondition` busca señales en toda la página y, ante cualquier coincidencia, usa `Reacondicionado` como valor predeterminado.

## Decisión

La condición generada por la IA se conservará salvo que exista evidencia explícita y atribuible al producto principal. Se aceptarán como evidencia:

1. Un campo de ficha o tabla cuyo nombre sea `Condición del producto` o `Condición` y cuyo valor contenga una condición reconocible.
2. Datos estructurados JSON-LD del producto principal con un campo de condición reconocible, cuando esté disponible.

No se considerarán evidencia las coincidencias globales en el texto completo, productos relacionados, banners, scripts genéricos, la URL ni sus parámetros.

## Alternativas descartadas

- Limitar la búsqueda a un contenedor visual principal: depende demasiado del HTML particular de cada tienda.
- Confiar únicamente en la IA: evita el falso positivo, pero perdería correcciones útiles cuando la tienda declara explícitamente la condición.
- Mantener la búsqueda global con exclusiones: sería frágil y exigiría añadir excepciones por tienda.

## Flujo

1. El proveedor de IA genera el producto estructurado.
2. El Worker busca una condición explícita en campos de producto o JSON-LD.
3. Si encuentra una evidencia válida, normaliza y aplica ese valor.
4. Si no la encuentra, devuelve sin cambios la condición de la IA.

## Pruebas

- Mantener `Nuevo` cuando una recomendación secundaria menciona `Reacondicionado`.
- Mantener `Nuevo` cuando la URL contiene `refurbished=false`.
- Mantener `Nuevo` cuando solo un script o JSON ajeno contiene la palabra.
- Cambiar a `Reacondicionado` cuando la tabla principal declara esa condición.
- Validar el Worker desplegado con el monitor ASUS de SCGlobal proporcionado por el usuario.

## Despliegue

Ejecutar la suite local, desplegar con Wrangler y realizar una petición real al Worker. La respuesta debe conservar la condición `Nuevo` para el enlace de prueba salvo que la página exponga una condición explícita distinta.
