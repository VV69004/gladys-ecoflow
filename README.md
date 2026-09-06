# gladys-ecoflow

Intégration externe Gladys Assistant pour la batterie EcoFlow RIVER 2, avec
deux modes : l'API officielle EcoFlow Developer (Public API), et un mode
"Connexion appli" non officiel pour les modèles absents du catalogue
officiel (confirmé : le River 2 de base, contrairement au River 2 Pro).

## Contenu du projet

- `src/index.js` — point d'entrée : relie le SDK Gladys aux deux clients
  EcoFlow (scan, sondage périodique ou événementiel selon le mode,
  publication des états, commandes).
- `src/ecoflow-client.js` — client HTTP signé HMAC-SHA256 pour l'API
  Developer EcoFlow officielle.
- `src/ecoflow-app-mqtt-client.js` — client MQTT non officiel (connexion
  appli), pour les modèles absents du catalogue Developer API.
- `src/device-river2.js` — mapping des champs "quota" EcoFlow vers les
  fonctionnalités d'appareil Gladys (niveau de batterie, puissances, etc.) —
  partagé par les deux modes.
- `gladys-assistant-integration.json` — manifeste de l'intégration.
- `docs/en.md`, `docs/fr.md` — documentation affichée aux utilisateurs.
- `Dockerfile` — image du conteneur.

## Avant de publier

1. Remplacez `your-github-username` par votre pseudo GitHub dans
   `gladys-assistant-integration.json` (`docker_image`), et créez votre
   propre dépôt public sur GitHub avec ce contenu.
2. Ajoutez le topic GitHub `gladys-assistant-integration` à ce dépôt.
3. Construisez et poussez l'image :
   ```bash
   docker build -t ghcr.io/your-github-username/gladys-ecoflow:0.1.0 .
   docker push ghcr.io/your-github-username/gladys-ecoflow:0.1.0
   ```
   (rendez le package public sur GitHub Packages)
4. Validez le manifeste avant de taguer :
   ```bash
   npx github:GladysAssistant/integration-store .
   ```
5. Taguez la release :
   ```bash
   git tag v0.1.0
   git push --tags
   ```

## Tester en local sans tout publier

Le plus rapide : exécuter le code comme un simple process Node.js contre une
instance Gladys en mode développeur (voir la doc officielle "Étape 4" —
Construire et tester en local). Installez l'intégration en mode développeur
dans Gladys pour obtenir un token et un selector, puis :

```bash
npm install
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="gladys-ecoflow" \
LOG_LEVEL=debug \
npm start
```

## État du contrôle (AC/12V)

Lecture seule par défaut. Voir `docs/fr.md` pour l'activer en mode
expérimental une fois que vous avez trouvé le `cmdCode` exact de votre
appareil/firmware (non documenté publiquement par EcoFlow pour tous les
modèles).
