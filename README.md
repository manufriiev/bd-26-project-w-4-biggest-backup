# BD26_Project_W4_B

# Run local

from the main folder you can run 
```bash
docker compose up -d --build
```
If you need to rebuild the project you can run 
```bash
docker compose down -v
```

you will find the web interface under 
```
http://localhost:5173/
```
make sure that _frontend/src/config.js_ has correct BACKEND and WS_LINK variables
# Cloud deployment

current cloud_deploy branch which is regularly updated to represent **main** is deployed on GCP under
```
http://34.28.224.202:5173/
```

