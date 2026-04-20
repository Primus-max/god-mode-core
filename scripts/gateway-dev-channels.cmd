@echo off
rem Launch dev gateway with Telegram channels enabled and full debug footer.
rem Uses explicit env exports so no quote-nesting surprises.

setlocal
set OPENCLAW_DEBUG_REPLY_ROUTING=1
set OPENCLAW_SKIP_CHANNELS=0

echo [gateway-dev-channels.cmd] starting at %DATE% %TIME%
echo [gateway-dev-channels.cmd] env: OPENCLAW_DEBUG_REPLY_ROUTING=%OPENCLAW_DEBUG_REPLY_ROUTING%
echo [gateway-dev-channels.cmd] env: OPENCLAW_SKIP_CHANNELS=%OPENCLAW_SKIP_CHANNELS%

call "C:\Users\Tanya\AppData\Roaming\npm\pnpm.cmd" gateway:dev:channels
