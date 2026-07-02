name: Alerta de límite de tarjeta

on:
  schedule:
    - cron: '0 14 * * *'   # 8:00 AM El Salvador (UTC-6) todos los días
  workflow_dispatch: {}     # permite correrlo manualmente desde la pestaña "Actions" para probar

permissions:
  contents: write            # necesario para poder guardar el estado (último ciclo ya alertado)

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout del repositorio
        uses: actions/checkout@v4

      - name: Configurar Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Instalar dependencias
        working-directory: automation
        run: npm install

      - name: Ejecutar chequeo de límite
        working-directory: automation
        env:
          GMAIL_USER: ${{ secrets.GMAIL_USER }}
          GMAIL_APP_PASSWORD: ${{ secrets.GMAIL_APP_PASSWORD }}
          ALERT_EMAIL_TO: ${{ secrets.ALERT_EMAIL_TO }}
        run: node check-limite.js

      - name: Guardar estado si cambió (evita correos duplicados)
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add automation/state/last-alert.json
          git diff --staged --quiet || git commit -m "chore: actualizar estado de alerta de tarjeta"
          git push

