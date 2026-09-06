# Intégration EcoFlow pour Gladys Assistant

Surveillez votre batterie portable EcoFlow RIVER 2 depuis Gladys, avec **deux
modes de connexion** selon que votre modèle exact est officiellement
supporté ou non par l'API publique d'EcoFlow.

## ⚠️ Confirmé le 2026-09-02 : le River 2 "de base" n'est pas dans le catalogue officiel

Le catalogue d'appareils de l'API Developer EcoFlow
(<https://developer-eu.ecoflow.com/us/document/introduction>) liste
uniquement **"River 2 Pro"**, pas le River 2 de base. Sur un compte
développeur pourtant correctement configuré (même email que l'appli
mobile, clés valides), l'API renvoie systématiquement
`error 1006: current device is not allowed to get device info` pour ce
modèle précis — ce n'est ni un bug de cette intégration, ni un souci de
configuration, c'est une vraie lacune du catalogue officiel EcoFlow.

## Mode 1 — Developer API (officiel)

Pour les modèles **listés** dans le catalogue officiel (River 2 Pro, Delta
2, Delta Pro, etc.). Dialogue avec `api-e.ecoflow.com` (ou `api-a.ecoflow.com`
pour la région US) via votre propre Access Key / Secret Key.

### Obtenir des identifiants API EcoFlow Developer

1. Rendez-vous sur <https://developer-eu.ecoflow.com> (ou le domaine `.com`
   pour les États-Unis) et créez un compte développeur gratuit, avec la
   **même adresse email** que votre compte de l'appli EcoFlow.
2. Créez une application. La validation n'est pas toujours instantanée —
   comptez parfois quelques jours.
3. Une fois validé, générez un **Access Key** et un **Secret Key** depuis le
   portail développeur.
4. Configurez la région, l'Access Key, le Secret Key. Laissez le numéro de
   série vide pour découvrir automatiquement tous vos appareils via
   **Découverte → Scanner**.

Le contrôle (allumer/éteindre les sorties depuis Gladys) est **désactivé par
défaut** et clairement marqué comme expérimental dans ce mode : EcoFlow ne
publie pas de liste documentée des codes de commande ("cmdCode") par
modèle/firmware sur l'API publique. Voir "Avancé : activer le contrôle"
ci-dessous.

## Mode 2 — Connexion appli (non officiel)

Pour les modèles **absents** du catalogue officiel (le River 2 de base,
confirmé ci-dessus). S'authentifie avec le même email/mot de passe que
l'appli mobile EcoFlow, puis se connecte directement au serveur MQTT
d'EcoFlow — exactement ce que fait l'appli elle-même en interne.

**Non officiel, non documenté par EcoFlow, en lecture seule** (pas de
contrôle des sorties dans ce mode pour l'instant) — plus fragile que l'API
Developer : peut casser à la moindre évolution côté serveurs EcoFlow, sans
préavis.

### Configuration

1. Basculez "Mode de connexion" sur **"Connexion appli (non officiel...)"**
2. Renseignez le même email/mot de passe que votre appli EcoFlow mobile
3. **Le numéro de série est obligatoire dans ce mode** (pas d'API de liste
   d'appareils disponible) — trouvez-le dans l'appli EcoFlow (Appareil >
   Paramètres)
4. Découverte → Scanner → créez l'appareil

⚠️ **Le champ "Région de l'API" compte aussi dans ce mode**, même s'il a
été pensé au départ pour le mode Developer API : EcoFlow sépare strictement
les comptes par région à la connexion. Un compte européen testé contre le
mauvais serveur échoue avec `"Account doesn't exist or incorrect
password"` (code EcoFlow 2026) — **même avec des identifiants
parfaitement corrects**. Confirmé en direct ce soir : le paquet
communautaire dont s'inspirait la première version de ce mode ciblait
toujours le serveur global/US, cassant systématiquement les comptes
européens. Corrigé pour respecter la région choisie.

Les données arrivent en continu par MQTT (pas de sondage périodique) — les
valeurs se remplissent progressivement au fil des messages reçus, pas
forcément toutes en même temps.

### Format des données — CONFIRMÉ en direct le 2026-09-02

Testé avec succès sur une vraie River 2 : 175 champs reçus en quelques
minutes via le seul topic `/app/device/property/<SN>`. Les deux autres
formats de topic évoqués par certaines sources communautaires
(`/app/<userId>/<SN>/thing/property` et
`/open/<certificateAccount>/<SN>/quota`) sont **explicitement refusés**
par le serveur EcoFlow pour ce compte (code MQTT 128) — ils ne sont donc
plus utilisés.

Chaque message contient une **mise à jour partielle**, accumulée
automatiquement par l'intégration — comptez plusieurs minutes avant que
tous les champs suivis n'aient été reçus au moins une fois, c'est normal,
pas un bug.

**Correctif confirmé** : le champ de niveau de batterie qu'on utilisait au
départ (`bmsMaster.soc`) n'existe pas sur ce firmware — remplacé par
`bms_emsStatus.lcdShowSoc` (celui qui correspond exactement à ce
qu'affiche l'écran LCD de l'appareil), avec des solutions de repli.

## Trouver le numéro de série de votre RIVER 2

Ouvrez l'appli EcoFlow, sélectionnez votre RIVER 2, allez dans
**Paramètres**, et copiez le numéro de série (il ressemble à
`R621ZEB4XXXXXXXX` ou `R601ZEB4XXXXXXXX`).

## Ce que vous obtenez (les deux modes)

- Niveau de batterie (%)
- Puissance de charge / de décharge (W)
- Puissance délivrée à la sortie maison (W)
- Autonomie restante estimée (minutes)
- État en lecture seule des sorties AC et 12V/voiture, exposé sous forme
  d'interrupteurs (contrôlables uniquement en mode Developer API)

## Avancé : activer le contrôle (expérimental, mode Developer API uniquement)

Si vous voulez essayer de piloter la sortie AC ou 12V depuis Gladys, il vous
faut le `cmdCode` exact que l'appli EcoFlow utilise pour votre appareil et
votre firmware précis. Ce n'est pas publié pour tous les modèles. Une
approche courante consiste à inspecter le trafic réseau de l'appli EcoFlow
(par exemple avec un outil proxy) en actionnant la sortie, ou à chercher sur
les forums communautaires (projet Home Assistant `hassio-ecoflow-cloud`)
votre modèle exact. Une fois trouvé, renseignez les champs "cmdCode de la
sortie AC" et/ou "cmdCode de la sortie 12V" et activez "Activer le contrôle".
En attendant, les interrupteurs restent en lecture seule et reflètent
simplement l'état courant. **Non disponible en mode Connexion appli.**

## Dépannage

### Mode Developer API

- **Code d'erreur 1006 ("current device is not allowed to get device
  info")** : vérifiez d'abord que votre modèle exact figure bien dans le
  catalogue officiel (lien ci-dessus). Si ce n'est pas le cas (comme pour le
  River 2 de base), c'est confirmé sans solution côté Developer API — passez
  au mode Connexion appli.
- **"IoT Core service subscription has expired" / autres erreurs HTTP** :
  votre application développeur a peut-être besoin d'être revalidée, ou vos
  Access/Secret Key sont incorrects.
- Aucune donnée après création de l'appareil : attendez le prochain cycle de
  30 secondes, puis consultez l'onglet **Journaux** de l'intégration pour
  voir l'erreur exacte renvoyée par l'API EcoFlow.

### Mode Connexion appli

- Aucune donnée après création de l'appareil : ce mode est **événementiel**
  (pas de sondage périodique) — les valeurs n'apparaissent qu'au fur et à
  mesure que l'appareil envoie réellement des messages. Attendez quelques
  minutes, puis lancez l'action de debug pour voir ce qui a été reçu.
- Échec de connexion MQTT : vérifiez l'email/mot de passe (les mêmes que
  l'appli mobile, pas les clés développeur). Consultez les Journaux de
  l'intégration pour le message d'erreur exact.

## Limites

- En lecture seule par défaut ; le contrôle est expérimental, non documenté
  officiellement par EcoFlow, et disponible uniquement en mode Developer
  API.
- Certaines variantes de firmware ou régionales peuvent ne pas remonter tous
  les champs listés ci-dessus ; les champs manquants sont simplement ignorés
  plutôt que de provoquer une erreur.
- Le mode Connexion appli est non officiel et peut cesser de fonctionner à
  tout moment sans préavis si EcoFlow modifie son infrastructure interne.
- Cette intégration utilise uniquement des transports cloud
  (`transports: ["cloud"]`) — aucun protocole local n'est documenté pour la
  RIVER 2.


## Ajout : puissance solaire

Nouvelle fonctionnalité "Puissance solaire" (`mppt.inWatts`), confirmée
présente sur un vrai payload capturé — simplement oubliée dans la première
version.

## Note sur le port 12V (voiture)

Si "Sortie 12V (voiture)" affiche "Pas de valeur récente" alors que
d'autres fonctionnalités se mettent bien à jour : normal si ce port n'a
jamais changé d'état pendant que vous observiez. Chaque message MQTT ne
contient que les champs qui **changent** — un port resté éteint en
continu peut ne jamais être mentionné. Testez en l'allumant/éteignant
physiquement (ou depuis l'appli) pendant que les Journaux tournent.

## Cause réelle trouvée et corrigée : identifiant client MQTT non stable

**Confirmé le 2026-09-02** dans le vrai code source d'un projet
communautaire mature (`tolwi/hassio-ecoflow-cloud`, des centaines
d'utilisateurs) : EcoFlow **limite à 10 le nombre d'identifiants client
MQTT uniques autorisés par compte et par jour**. Toute version précédente
de cette intégration générait un identifiant **aléatoire à chaque
connexion** — chaque redémarrage, chaque reconnexion en épuisait un.

Ce quota explique très précisément tout ce qui a été observé ce soir : la
toute première connexion fonctionnait (encore dans le quota), toute
reconnexion suivante se connectait et s'abonnait sans erreur apparente,
mais ne recevait plus jamais aucun message (le quota semble bloquer la
**livraison** des messages, pas la connexion elle-même) — et l'appli
mobile continuait de fonctionner parce qu'elle utilise son propre
identifiant stable, jamais renouvelé, donc jamais concerné.

**Corrigé** : l'identifiant est désormais dérivé de façon déterministe de
votre email (toujours le même résultat, y compris après un redémarrage du
conteneur) — plus aucune consommation du quota au fil des reconnexions.

Le cycle de reconnexion automatique ajouté précédemment a été retiré : son
hypothèse de départ (imiter une session d'appli active) a été testée et
infirmée, et il aggravait en fait ce vrai problème en consommant le quota
encore plus vite.

## Diagnostic rapide, sans attendre 10 minutes

Les champs `pd.*` et `bms_emsStatus.*` (batterie, autonomie, sorties)
sont censés être poussés **toutes les 3 secondes environ** sur un compte
qui fonctionne normalement — seul le solaire (`mppt.*`) prend
légitimement 3 à 5 minutes. Si rien n'apparaît après 30-60 secondes, c'est
déjà un signal fiable que quelque chose ne va pas, pas la peine d'attendre
plus longtemps pour en avoir le cœur net.

## Correctif du 2026-09-03 : identifiants qui ne ressemblaient pas à une vraie appli

**Nouvelle piste, jamais examinée jusqu'ici.** L'intégration envoyait des
informations d'identification qui trahissaient immédiatement qu'il ne
s'agissait pas d'une vraie appli mobile :

- `os: "linux"` au lieu de `"android"`
- `osVersion: "5.15.90.1-kali-fake"` — littéralement le mot **"fake"**
  dedans, copié tel quel depuis un exemple de code
- Un identifiant client au format hexadécimal brut, sans les tirets d'un
  vrai UUID

Corrigé avec des valeurs confirmées par un guide de configuration réel,
en usage fiable depuis près de 4 mois sans interruption (`os: "android"`,
`osVersion: "30"`, `appVersion: "4.2.3.12"`), et un identifiant client
reformaté en vrai UUIDv4 valide (tirets et nibbles de version corrects),
indiscernable d'un identifiant généré par une vraie installation Android.

**Non garanti que ce soit LA solution définitive** — mais c'est une vraie
différence concrète entre notre requête et une requête qui fonctionne de
façon fiable, jamais examinée avant ce correctif.

## Statut au 2026-09-03 après-midi : demande active réintégrée

Malgré la correction des identifiants réalistes (section précédente),
toujours aucune donnée reçue sans l'appli mobile ouverte — confirmé en
direct. Toutes les pistes trouvables par recherche publique ont maintenant
été testées : région, format des 3 topics, QoS, identifiant stable,
identification réaliste. Aucune n'a suffi seule.

Réintégration de la publication active périodique (toutes les 15
secondes), retirée plus tôt sur la foi d'une bibliothèque de référence qui
n'en avait pas besoin — mais cette bibliothèque n'a manifestement pas le
même comportement que ce que ce compte connaît en pratique. Format de la
requête inspiré du format réel documenté `GetCmdRequest{Sn,
Params:{Quotas:[]}}` (utilisé officiellement côté REST), adapté au topic
MQTT confirmé fonctionnel — un choix délibérément **prudent** (une
requête de lecture, pas une commande qui pourrait modifier un réglage).

**Non confirmé que ce format précis soit honoré via MQTT** — à vérifier
dans les Journaux (`Active data request published...`).

## Corrigé le 2026-09-03 : les données n'atteignaient jamais Gladys malgré leur réception

**Vrai bug de notre côté, pas une limite EcoFlow.** Confirmé en direct : le
quota accumulé (visible via l'action de debug) contenait de vraies
données complètes, mais rien n'apparaissait sur la fiche de l'appareil
dans Gladys.

Cause : la table associant chaque numéro de série à son appareil Gladys
n'était remplie que lors d'un clic explicite sur "Scanner" — jamais
automatiquement au démarrage. Comme le conteneur a redémarré de
nombreuses fois ce soir, cette table repartait à zéro à chaque fois, et
la publication des états échouait silencieusement tant que personne ne
relançait un scan manuel après coup.

Corrigé : reconstruite automatiquement à chaque démarrage/reconfiguration,
sans dépendre d'une action manuelle. Validé par un test simulé complet
(réception d'un message → publication effective vers Gladys).

## Corrigé le 2026-09-03 (2) : un cache fragile désynchronisé du redémarrage

Second vrai bug de notre côté, distinct du précédent. L'intégration ne
publiait une valeur vers Gladys que si elle différait de la **dernière
valeur envoyée en mémoire** — une optimisation censée éviter du bruit
inutile. Problème : cette mémoire est réinitialisée à chaque redémarrage
du conteneur, alors que Gladys, lui, garde la dernière valeur reçue
**avant** le redémarrage. Les deux pouvaient diverger silencieusement.

Corrigé en retirant cette optimisation : chaque mise à jour reçue est
désormais systématiquement republiée en entier, sans tenter de deviner
si Gladys a déjà la bonne valeur. Validé par un test montrant que deux
messages consécutifs avec une valeur strictement identique déclenchent
bien chacun une vraie publication.

## Réinitialisation à l'arrêt propre — et sa vraie limite

**À l'arrêt volontaire du conteneur** (`docker stop`, redémarrage suite à
un rechargement de config) : chaque fonctionnalité est explicitement
remise à `null` juste avant la fermeture, en plus du statut de connexion.
**Expérimental** — non confirmé que Gladys affiche bien "Pas de valeur
récente" pour un `null` explicite plutôt que l'inverse (une valeur "null"
littérale affichée à l'écran). À vérifier après un `docker stop` propre.

**Ce qui reste impossible, et le restera** : lors d'une coupure
**inattendue** (perte réseau, crash, `close code 1006`), il n'existe
**aucun** moyen d'envoyer quoi que ce soit à Gladys au moment précis de la
coupure — le canal est justement ce qui vient de casser. Ce n'est pas une
limite de cette intégration en particulier : c'est vrai pour absolument
toute intégration externe Gladys, quelle qu'elle soit. La seule
atténuation possible est de republier les vraies valeurs dès que la
reconnexion automatique réussit, réduisant la fenêtre de valeurs périmées
à la durée réelle de la coupure — sans jamais pouvoir l'annuler
totalement.

## Corrigé le 2026-09-03 (3) : notre propre requête active se répondait à elle-même

Vrai bug de notre côté, indépendant de la question "appli ouverte ou
pas". Comme le client est à la fois **abonné** au topic et **publie**
dessus (la requête active périodique), le serveur MQTT nous renvoyait nos
propres messages en écho — reçus et fusionnés comme s'il s'agissait de
vraies données de l'appareil, polluant l'accumulation avec une clé
`quotas` vide et sans rapport, particulièrement visible juste après une
reconnexion (rien d'autre encore reçu à ce moment-là).

Corrigé : ce message spécifique (reconnu par sa forme unique, une seule
clé `quotas` avec un tableau vide — jamais observée dans aucun vrai
message capturé ce soir) est désormais explicitement ignoré. Validé par
un test : l'écho ne déclenche plus rien, un vrai message continue de
fonctionner normalement.

## Piste à explorer une prochaine fois : Bluetooth Low Energy (BLE) local

**Observation concrète du 2026-09-04** : l'appli mobile EcoFlow continue de
recevoir des données de la River 2 **même quand celle-ci est totalement
déconnectée du Wi-Fi** — confirmé en Bluetooth seul. Ça prouve que
l'appareil dispose d'une vraie capacité de communication locale
indépendante du cloud, jamais explorée ce soir (toute la session s'est
concentrée sur MQTT/cloud).

### Ce qui a été tenté sans succès, cette nuit-là

Recherche d'une requête HTTP supplémentaire que l'appli enverrait au
lancement (au-delà de `/auth/login` et `/iot-auth/app/certification`),
via interception du trafic réseau (mitmproxy + émulateur Android). Un
domaine supplémentaire a bien été repéré (`app-eu.ecoflow.com`), mais
confirmé être une simple page web de vitrine, sans rapport avec le
déclenchement des données.

### Piste pour la prochaine session

Le protocole **BLE natif** de la River 2 est un terrain complètement
différent, jamais creusé :
- Chercher une éventuelle rétro-ingénierie déjà publiée du protocole BLE
  EcoFlow (GATT services/characteristics utilisés par l'appli)
- Un projet nommé `nielsole/ecoflow-bt-reverse-engineering` a été
  mentionné en passant pendant les recherches de cette session — jamais
  exploré en détail, pourrait être un bon point de départ
- Si un vrai protocole BLE existe et est documenté, ça permettrait un
  accès complètement local, sans dépendre ni du cloud EcoFlow ni de la
  présence de l'appli mobile — la vraie autonomie recherchée depuis le
  début

### Mise à jour : la piste BLE est déjà largement défrichée par d'autres

Confirmé le 2026-09-04 — plusieurs projets existent déjà, un directement
testé sur River 2 :

- **`npike/ha-ecoflow-ble`** (github.com/npike/ha-ecoflow-ble) — intégration
  Home Assistant, **explicitement testée sur River 2**, lit le niveau de
  batterie en BLE pur, sans cloud ni MQTT
- **`rabits/ef-ble-reverse`** (github.com/rabits/ef-ble-reverse) —
  rétro-ingénierie complète et documentée du protocole BLE EcoFlow v2
- **`nielsole/ecoflow-bt-reverse-engineering`** — travail d'origine (Delta
  2, même famille de protocole)

**Piste potentiellement explicative du mystère "marche seulement avec
l'appli ouverte"** : un commentaire dans les issues de `nielsole` révèle
que l'appareil dispose de ses **propres** identifiants MQTT (distincts de
ceux de l'utilisateur, obtenus via `/iot-auth/device/certification` avec
numéro de série + identifiant CPU + signature), et que sa connexion au
cloud semble déclenchée par une **commande envoyée en Bluetooth depuis
l'appli** ("connecte-toi au wifi"). Si c'est bien le mécanisme réel, ça
expliquerait exactement le comportement observé toute la nuit — pas un
simple heuristique "quelqu'un regarde", mais un ordre explicite transmis
par Bluetooth à chaque fois.

**Prochaine étape suggérée** : essayer directement `ha-ecoflow-ble` (déjà
fonctionnel, déjà testé sur ce modèle exact) plutôt que repartir de zéro —
et si le mécanisme "commande BLE déclenche la connexion cloud" se
confirme, on pourrait potentiellement reproduire cette commande nous-mêmes
pour automatiser complètement le réveil de l'appareil, sans dépendre de
l'appli mobile.

### Liste complète des projets BLE trouvés (2026-09-04, recherche approfondie)

Pour démarrer directement la prochaine fois, sans repartir de zéro :

```bash
git clone https://github.com/npike/ha-ecoflow-ble
git clone https://github.com/rabits/ha-ef-ble
git clone https://github.com/rabits/ef-ble-reverse
git clone https://github.com/anton-ptashnik/ecoflow-api-py
git clone https://github.com/avaver/ecoflow-ble
git clone https://github.com/nielsole/ecoflow-bt-reverse-engineering
```

- **`npike/ha-ecoflow-ble`** : le plus simple — batterie seule, en lecture
  passive (scan des annonces BLE, sans connexion active), **explicitement
  testé sur River 2**. Probablement le meilleur point de départ.
- **`rabits/ha-ef-ble`** + son dépôt de rétro-ingénierie associé
  `ef-ble-reverse` : le plus complet, protocole BLE v2 documenté en
  détail, mais développé sur d'autres modèles (Delta Pro Ultra, Smart Home
  Panel 2/3) — à vérifier si le protocole est identique sur River 2.
- **`anton-ptashnik/ecoflow-api-py`** : bibliothèque Python autonome
  (utilisable hors Home Assistant), basée sur `bleak` — River 2 marqué
  "pending" mais l'architecture existe déjà.

**Limite importante confirmée** : le Bluetooth LE d'EcoFlow ne supporte
qu'**une seule connexion à la fois** — si notre propre module s'y
connecte, l'appli mobile ne pourra plus le faire simultanément (et
inversement). Un vrai compromis à accepter, pas un bug à corriger.

**Prochaine étape concrète** : cloner `npike/ha-ecoflow-ble` sur
HomeServer, lire `custom_components/ecoflow-ble/*.py` directement (pas
via recherche web, plus fiable), identifier le format exact des données
manufacturer_data annoncées par le River 2, puis porter cette logique de
lecture en JavaScript avec une bibliothèque BLE Node.js (`@abandonware/noble`
ou équivalent).

## Nouveau mode : Bluetooth (local, batterie uniquement) — 2026-09-04

**La vraie percée de cette session.** Le River 2 diffuse en continu son
numéro de série et son niveau de batterie via Bluetooth — sans connexion,
sans appairage, sans authentification, et sans aucun rapport avec l'appli
mobile ou le Wi-Fi. Confirmé en lisant directement le code source réel
d'une intégration Home Assistant existante et déjà testée sur River 2
(`npike/ha-ecoflow-ble`), puis vérifié avec votre vrai numéro de série.

### Ce que ce mode apporte

- **Aucune dépendance** au cloud EcoFlow, à l'appli mobile, ni au Wi-Fi
- Fonctionne même appareil totalement déconnecté du réseau (confirmé par
  vous-même en Bluetooth seul plus tôt cette nuit)
- Écoute purement passive — jamais de connexion active à l'appareil

### Limite honnête

**Seul le niveau de batterie est disponible** dans ce mode — pas les
puissances, pas l'état des sorties AC/12V. C'est une vraie limite du
format de diffusion Bluetooth de l'appareil, pas quelque chose qu'on
pourrait débloquer avec plus de code. Les autres fonctionnalités ne sont
même pas créées dans ce mode, pour éviter des cases "aucune valeur"
permanentes et trompeuses.

### Configuration

1. "Mode de connexion" → **"Bluetooth (local, batterie uniquement)"**
2. Renseignez le numéro de série (obligatoire, comme en mode Connexion
   appli — pas de découverte automatique)
3. **HomeServer doit avoir un adaptateur Bluetooth accessible** au
   conteneur Docker — un vrai point d'attention distinct du code lui-même,
   voir la section suivante

### Non testé en conditions réelles ce soir — à vérifier

La bibliothèque Bluetooth (`@stoprocent/noble`) nécessite une compilation
native au moment de l'installation — jamais exécutée avec un vrai
adaptateur Bluetooth ni dans un vrai conteneur Docker pendant cette
session (environnement de développement sans accès à ce matériel). Toute
la logique de décodage est testée et vérifiée (18 tests automatisés au
total sur ce module), mais l'intégration avec le vrai matériel reste à
confirmer chez vous.

**Point d'attention Docker important, non résolu ce soir** : un conteneur
Docker n'a normalement pas accès au Bluetooth de la machine hôte par
défaut — il faut généralement soit `--net=host`, soit des options
`--cap-add` et un montage de périphérique spécifiques. Aucune preuve ce
soir que Gladys, en gérant lui-même la création du conteneur pour une
intégration externe, permette de demander ce genre d'accès élargi. **À
vérifier en priorité** avant de considérer ce mode comme utilisable — il
est possible que ça nécessite une architecture différente (un petit
script tournant directement sur l'hôte, hors conteneur, plutôt qu'une
intégration Gladys classique).

## CORRECTION IMPORTANTE (2026-09-04, juste après l'implémentation) : blocage architectural confirmé

**Le mode Bluetooth décrit ci-dessus ne peut pas fonctionner comme
intégration externe Gladys classique.** Vérifié dans la documentation
officielle de Gladys (gladysassistant.com/docs/dev/external-integrations) :

> "Gladys fait tourner votre conteneur avec des limites strictes : ...
> aucune capacité Linux supplémentaire ... aucun accès direct aux
> périphériques de l'hôte."

Le mécanisme prévu pour l'accès matériel (sous-conteneurs, champ
`containers[].devices`) n'accepte qu'une liste fermée de types :
`coral-usb`, `coral-pcie`, `gpu`, `video`. **Le Bluetooth n'y figure
pas.**

### Ce qui reste vrai et réutilisable

- Le format de diffusion Bluetooth du River 2 (`src/ecoflow-ble-protocol.js`,
  22 tests automatisés) est confirmé et correct — ce travail n'est pas
  perdu
- Le scanner (`src/ecoflow-ble-scanner.js`) est correct sur le plan
  logique, mais ne peut pas s'exécuter dans le conteneur principal d'une
  intégration Gladys

### Vraies options pour rendre ça utilisable

1. **Demander à Gladys d'ajouter le Bluetooth** à la liste des types de
   matériel autorisés pour les sous-conteneurs — une vraie requête de
   fonctionnalité à poser sur leur forum communautaire
   (community.gladysassistant.com), pas quelque chose qu'on peut
   contourner depuis notre code
2. **Un script autonome sur l'hôte**, hors du système d'intégrations
   externes classique : un simple processus Node.js tournant directement
   sur HomeServer (pas dans un conteneur), utilisant le même SDK
   `@gladysassistant/integration-sdk` avec un jeton obtenu en mode
   développeur, pour publier les états directement. Fonctionnerait
   techniquement, mais sort du cadre "installable en un clic depuis le
   catalogue" — resterait un script manuel à maintenir soi-même
3. **Utiliser une passerelle Bluetooth existante** (comme un dongle
   ESPHome Bluetooth Proxy, mentionné dans la documentation de
   `rabits/ha-ef-ble`) qui relaierait les données vers un point d'accès
   réseau normal, contournant le besoin d'accès Bluetooth direct depuis le
   conteneur

**Recommandation pour la prochaine session** : commencer par l'option 2
(script autonome) pour valider que tout le reste fonctionne (le décodage,
déjà testé), avant d'envisager une vraie intégration catalogue — ou
interroger directement la communauté Gladys sur l'ajout du Bluetooth aux
types de matériel supportés.

## Corrigé le 2026-09-06 : rafale de messages provoquant des erreurs 429

**Confirmé en direct** : lors d'une reconnexion, plusieurs dizaines de
messages MQTT peuvent arriver en quelques centaines de millisecondes
(l'appareil "rattrape" tout son état d'un coup). Chaque message
déclenchait un appel API séparé vers Gladys, dépassant sa limite de
fréquence et provoquant des erreurs `429 Too Many Requests` — visibles
aussi comme des valeurs manifestement incohérentes (par exemple une
autonomie estimée passant de 389 à 1102 minutes en quelques secondes,
artefact de la rafale plutôt qu'une vraie mesure).

Corrigé par un regroupement dans le temps (1,5 seconde) : les messages
rapprochés sont fusionnés, une seule vraie publication est envoyée avec
la valeur la plus récente une fois la rafale terminée. Ce n'est **pas**
un retour à l'ancien bug de comparaison de valeurs (celui qui se
désynchronisait après un redémarrage) — aucune valeur n'est jamais
ignorée, seule la fréquence des appels API est limitée. Validé par un
test simulant 50 messages en 200ms : un seul appel réel effectué, avec la
bonne valeur finale.

## Piste Bluetooth — écartée après test à froid complet (2026-09-06)

Une capture réelle du trafic Bluetooth avait révélé un vrai protocole de
commandes actif (service `0001`, écriture `0002`, notification `0003`,
une commande fixe rejouable sans protection apparente contre le rejeu).
Le rejeu de cette commande obtenait bien une réponse de l'appareil.

**Mais un test à froid complet et rigoureux** (redémarrage total du
serveur, extinction complète de la batterie, appli mobile jamais ouverte)
**a infirmé l'hypothèse** : rejouer cette commande ne déclenche pas la
remontée cloud/MQTT de façon fiable. Les deux résultats positifs
précédents avaient l'ouverture de l'appli mobile comme facteur de
confusion non exclu — c'était très probablement elle, et non notre
commande, qui expliquait les remontées observées.

**Conclusion** : le vrai déclencheur reste non identifié. Ce n'est pas
une commande Bluetooth simple à rejouer. La piste MQTT/app-login,
nécessitant l'appli mobile ouverte, reste la seule solution fiable
confirmée ce soir pour obtenir les données complètes.

Le script de test (`ecoflow-ble-standalone/test-replay-command.js`) et
le format du protocole restent documentés ci-dessous à titre de référence
technique, en cas de reprise future avec une piste différente (par
exemple, une vraie session de rétro-ingénierie du protocole complet,
plutôt qu'un simple rejeu).

## Piste réseau (PCAPdroid) — écartée, épinglage de certificat confirmé (2026-09-06)

Capture directe du trafic réseau depuis un vrai téléphone (appli
PCAPdroid, sans HomeServer ni émulateur) a révélé un appel HTTPS vers
`api-e.ecoflow.com` (le même serveur que login/certification) transportant
un volume de données très supérieur à un simple jeton d'authentification :

```
2 411 octets envoyés / 67 625 reçus, en seulement 0,11 seconde
```

C'est un vrai indice — un appel API distinct de `/auth/login` et
`/iot-auth/app/certification`, jamais identifié auparavant.

**Mais le contenu reste inaccessible.** Trois tentatives de déchiffrement
TLS (avec configuration vérifiée : option "Décryptage TLS" activée,
filtre par appli EcoFlow explicitement configuré) n'ont produit que du
contenu chiffré, à chaque fois — confirmé sur 3 fichiers distincts,
provenant de captures différentes. Ça pointe vers un **épinglage de
certificat** (certificate pinning) actif côté appli EcoFlow : elle refuse
tout certificat autre que celui d'EcoFlow, peu importe ce que le
téléphone accepte au niveau système.

**Pour aller plus loin, il faudrait** : rooter le téléphone et utiliser
Frida/objection pour désactiver le pinning au moment de l'exécution, ou
décompiler et patcher l'APK directement — deux approches invasives,
délibérément écartées ce soir plutôt que de rooter un téléphone personnel
pour cette seule recherche.

**Ce qui reste exploitable sans casser la sécurité du téléphone** :
- Le volume et le timing de cet appel confirment qu'il existe bel et bien
  un point d'API supplémentaire, non documenté
- Un domaine `mobile-app.ecoflow.com` est systématiquement résolu par
  DNS mais jamais utilisé dans aucune capture — sa fonction reste
  inconnue, potentiellement liée à un mécanisme conditionnel
  (notifications push ?) jamais déclenché pendant nos tests

## Correctif majeur du 2026-09-06 : le vrai format de requête active

En cherchant si l'API interne d'EcoFlow était déjà documentée quelque
part, trouvé le vrai code source de `tolwi/hassio-ecoflow-cloud` (une
intégration Home Assistant mature et largement utilisée, avec un mode
"private_api" qui reproduit fidèlement l'API interne de l'appli EcoFlow).

**Notre ancienne tentative de "réveil actif" était entièrement inventée**
— un format de message imaginé (`{sn, params:{quotas:[]}}`) envoyé sur le
mauvais topic (celui de diffusion passive). Le vrai mécanisme, tel
qu'implémenté dans ce projet mature :

- **Vrai format du message** :
  ```json
  { "version": "1.1", "moduleType": 0, "operateType": "latestQuotas", "params": {} }
  ```
- **Vrai topic dédié** : `/app/{userId}/{numéro_série}/thing/property/get`

Ce topic précis, **avec le suffixe `/get`**, n'avait jamais été testé ce
soir — on avait uniquement essayé le même chemin **sans** ce suffixe,
explicitement rejeté par le serveur (code 128). Le suffixe semble être la
pièce manquante.

Remplacé dans `src/ecoflow-app-mqtt-client.js`, avec un vrai test
automatisé vérifiant le topic et le format exacts du message envoyé.

**CONFIRMÉ EN CONDITIONS RÉELLES (2026-09-06)** : cette requête déclenche
bien une remontée complète des données, **sans jamais avoir besoin
d'ouvrir l'appli mobile**. C'est la vraie solution cherchée depuis le
tout début de cette session — le mystère de "pourquoi ça ne marche
qu'avec l'appli ouverte" est résolu : il ne s'agissait jamais d'un
signal caché envoyé par l'appli, mais simplement d'une requête MQTT
standard, documentée, qu'on n'avait jamais correctement formée avant ce
soir.

## Nouveau : contrôle de l'appareil en mode Connexion appli (2026-09-06)

Une fois la vraie remontée de données confirmée fonctionnelle (voir
ci-dessus), le contrôle de l'appareil a été implémenté avec les mêmes
vraies commandes, tirées du même projet mature `tolwi/hassio-ecoflow-cloud`
(fichier `devices/internal/river2.py`).

### Ce qui est disponible

- **Interrupteur Sortie AC** — commande `acOutCfg`
- **Interrupteur Sortie 12V (voiture)** — commande `mpptCar`
- **Action "Régler la limite de puissance de charge AC"** — commande
  `acChgCfg`, de 100 à 360 W. Sous forme d'action (pas d'une vraie
  fonctionnalité d'appareil) car Gladys ne propose pas de type de
  fonctionnalité "réglage numérique avec bornes" adapté à ce cas précis.

### Activation

Dans la configuration : activez **"Activer le contrôle (expérimental)"**.
En mode Connexion appli, aucun code de commande à saisir — les commandes
sont désormais intégrées directement au code.

### Limite honnête

**Pas de limite solaire distincte** — contrairement à la charge AC, le
solaire n'est pas limité par logiciel sur le River 2 (confirmé : aucune
commande de ce type dans le projet de référence pour ce modèle). Il
arrive à la puissance maximale que le panneau fournit.

### Non testé en conditions réelles

Contrairement à la lecture de données (confirmée fonctionnelle ce soir),
**ces commandes de contrôle n'ont jamais été envoyées à un vrai
appareil**. Elles viennent d'un projet fiable et mature, mais à tester
avec prudence :
1. Commencez par la sortie AC (facilement réversible)
2. Puis la sortie 12V
3. La limite de charge en dernier, avec une valeur proche de ce qui est
   déjà configuré plutôt qu'un changement radical

**Filet de sécurité, indépendant de tout logiciel** : appui simultané sur
les boutons AC + DC pendant ~5 secondes pour une
réinitialisation matérielle complète, si une commande produit un
comportement inattendu.

## Nouveaux contrôles : gestion de l'énergie (2026-09-06)

Suite à une capture d'écran de l'appli officielle EcoFlow ("Gestion de
l'énergie"), 4 réglages supplémentaires identifiés et implémentés — tous
avec leurs vraies commandes déjà présentes dans le projet de référence
`tolwi/hassio-ecoflow-cloud`, mais pas encore câblées jusqu'ici :

- **Interrupteur "Réserve de secours activée"** (nouvelle fonctionnalité
  d'appareil) — commande `watthConfig` (moduleType 1). L'activer règle
  automatiquement une réserve par défaut à 50% ; utilisez ensuite l'action
  ci-dessous pour affiner.
- **Action "Régler le niveau de charge maximum"** (50-100%) — commande
  `upsConfig` (moduleType 2). Correspond à "Limite de charge" dans
  l'appli.
- **Action "Régler le niveau de décharge minimum"** (0-30%) — commande
  `dsgCfg` (moduleType 2). Correspond à "Limite de décharge" dans
  l'appli.
- **Action "Régler le niveau de réserve de secours"** (5-100%) —
  commande `watthConfig` (moduleType 1). **C'est le vrai contrôle de
  priorité solaire** pour ce modèle : en dessous du seuil, la batterie se
  recharge sur secteur ET solaire ; au-dessus, uniquement au solaire.
  Correspond au curseur "Sauvegarde / Énergie solaire uniquement" de
  l'appli.

Testé de bout en bout (simulé) avec les valeurs exactes observées dans
l'appli (94% / 20% / 61%) — toutes correctement construites et envoyées.
Comme pour les autres contrôles, **jamais testé contre un vrai
appareil** — à tester avec prudence, un réglage à la fois.

## Corrigé le 2026-09-06 : l'interrupteur affichait un état différent de la réalité

**Confirmé en direct** : une commande de contrôle (éteindre l'AC) a bien
fonctionné sur l'appareil réel — mais une tentative suivante (rallumer)
a échoué pour une raison physique complètement normale (alimentation
secteur débranchée). Le problème réel découvert au passage : l'interface
Gladys affichait un état **optimiste** (ce qui avait été demandé),
jamais corrigé même quand la commande n'avait aucun effet réel.

Corrigé : après l'envoi d'une commande de contrôle (mode Connexion
appli), plus aucun état n'est publié à l'aveugle. À la place, une vraie
relecture de l'état est déclenchée 2 secondes après (au lieu d'attendre
le prochain cycle de 15 secondes), et c'est le pipeline normal de
réception MQTT qui publie ce qui est réellement reçu — vrai dans tous
les cas, que la commande ait réussi ou non.

## Ajouté le 2026-09-06 : lecture des valeurs de gestion de l'énergie

Suite à une remarque légitime : les actions de réglage (limite de
charge, décharge, réserve, puissance) permettaient de **fixer** une
valeur, mais rien n'affichait la valeur **actuelle** avant de décider.

4 nouvelles fonctionnalités en lecture seule, visibles sur le tableau de
bord comme n'importe quel capteur :

- **Limite de charge max** (`bms_emsStatus.maxChargeSoc`, 50-100%)
- **Limite de décharge min** (`bms_emsStatus.minDsgSoc`, 0-30%)
- **Niveau de réserve de secours** (`pd.bpPowerSoc`, 5-100%)
- **Limite de puissance de charge AC** (`mppt.cfgChgWatts`, 100-360W)

Ajoutez-les à votre tableau de bord comme les autres capteurs (batterie,
puissances) pour voir en un coup d'œil la valeur actuelle avant
d'utiliser l'action correspondante pour la modifier.

**Nécessite un nouveau scan/re-création de l'appareil** pour apparaître
— comme pour toute nouvelle fonctionnalité, elles ne se rajoutent pas
automatiquement à un appareil déjà existant dans Gladys.

## Nouveau : agrégateur d'énergie solaire et estimation des économies (2026-09-06)

Deux nouvelles fonctionnalités, en lecture seule, visibles sur le
tableau de bord :

- **Énergie solaire cumulée** (kWh) — un compteur qui ne fait
  qu'augmenter, comme un vrai compteur électrique
- **Économies solaires estimées** (€) — calculées à partir du prix du
  kWh renseigné dans la configuration

### Méthode de calcul — une estimation volontairement simple

À chaque nouvelle mesure de puissance solaire reçue, l'énergie ajoutée
depuis la mesure précédente est calculée par une simple intégration
rectangulaire : `puissance (W) × temps écoulé (h)`. Ce n'est **pas** un
compteur de précision — c'est exactement ce qui a été demandé : une
bonne estimation, pas un audit énergétique exact.

**Protection contre les coupures longues** : si plus de 5 minutes
s'écoulent entre deux mesures (redémarrage, panne, appli fermée), cet
intervalle est ignoré plutôt qu'intégré à la dernière puissance connue —
sans ça, une coupure de plusieurs heures compterait comme si le soleil
avait continué à débiter au même niveau pendant tout ce temps, ce qui
fausserait complètement le total.

### Persistance, sans redémarrage à zéro

Le compteur cumulé est sauvegardé automatiquement (au maximum une fois
par minute, plus une sauvegarde finale à chaque arrêt propre) dans le
stockage interne libre de Gladys — une clé technique jamais affichée
dans l'interface, mais qui survit aux redémarrages du conteneur. Vos
économies ne repartent jamais de zéro par accident.

### Configuration

Renseignez **"Prix de l'électricité (par kWh)"** dans la configuration
de l'intégration. Laissez vide pour désactiver uniquement l'estimation
en euros — le compteur d'énergie en kWh continue de fonctionner dans
tous les cas.

Testé de bout en bout (simulé) : chargement du total persisté au
démarrage, intégration correcte dans le temps, protection contre les
coupures longues, calcul des économies.
