# MaquiRent

Boceto funcional del marketplace de maquinaria. Cinco celdas (Colombia, Estados Unidos, Brasil, Alemania y Francia), un plano global y un bus de eventos.

## Arrancar

```bash
npm start
```

Abre http://localhost:8080. Cada arranque borra los datos locales de la demo y vuelve a sembrar las cuentas. La contraseña es `demo123`.

Con Docker, el mismo sistema queda separado por proceso:

```bash
docker compose up --build
```

## Qué demuestra

- Búsqueda global y contrato en la celda del propietario, también si la cuenta está en otro país. El viaje y el flete entran en la cotización.
- Reserva con un único escritor por máquina, idempotencia y bandeja de salida.
- Saga: solicitada, pagada (retenida), entregada, devuelta, liquidada, en disputa o cancelada.
- Adaptadores simulados de pago y factura electrónica por país.
- Residencia de datos: el plano global no guarda correos. El dato personal sale de la celda de la cuenta solo cuando un contrato en otro país lo necesita.

`npm run smoke` recorre ese camino contra el servidor ya iniciado.
