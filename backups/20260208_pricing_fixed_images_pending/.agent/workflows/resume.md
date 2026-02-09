---
description: Resume development from the last saved state
---

To resume work exactly where we left off:

1. Read the latest handover state:
   ```
   view_file "C:\Users\kurae\.gemini\antigravity\brain\539b6ae8-14d3-4613-8c24-9b2cf67581a1\handover_state.md"
   ```

2. Verify project files:
   - [dashboard.js](file:///d:/契約/js/dashboard.js) (Main Logic)
   - [db-service.js](file:///d:/契約/js/db-service.js) (Data Layer)
   - [dashboard.css](file:///d:/契約/css/dashboard.css) (Split UI)

3. Start the local server (if not running):
   // turbo
   ```powershell
   .\start_server.bat
   ```

4. Open the latest walkthrough to confirm current UX:
   ```
   view_file "C:\Users\kurae\.gemini\antigravity\brain\539b6ae8-14d3-4613-8c24-9b2cf67581a1\walkthrough.md"
   ```
