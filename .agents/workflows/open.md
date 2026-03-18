---
description: Start backend and frontend servers and open the dashboard.
---
1. Start the backend server
// turbo
run_command(CommandLine="npm run dev", Cwd="d:\\契約\\backend", SafeToAutoRun=true, WaitMsBeforeAsync=2000)

2. Start the frontend server (static file server)
// turbo
run_command(CommandLine="npx -y serve . -l 3000 --no-clipboard", Cwd="d:\\契約", SafeToAutoRun=true, WaitMsBeforeAsync=2000)

3. Open the dashboard in the browser
// turbo
open_browser_url(url="http://localhost:3000/dashboard.html")

4. Verify the dashboard is loaded correctly
// turbo
browser_get_dom()
