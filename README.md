# SplitEasy (shared groups)

- index.html       the whole app (create a group, join with a 5-digit code)
- api/group.js     the server code (saves each group in Upstash Redis)
- package.json     just a name, nothing to install

Deploy: upload this folder to GitHub, import the repo in Vercel (Framework: Other),
then under Storage connect a free Upstash Redis database to the project and redeploy.
