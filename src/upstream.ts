/**
 * Re-export del transporte Baileys dentro de @sora/baileys.
 * Así el proyecto declara una sola dependencia de WhatsApp: @sora/baileys.
 *
 * Se sirve como subpath (`@sora/baileys/upstream`) para que el entry principal
 * siga funcionando sin el peer instalado.
 */
// @ts-ignore el peer es opcional: puede no estar instalado al compilar el core
export * from '@whiskeysockets/baileys'
// @ts-ignore
export { default } from '@whiskeysockets/baileys'
