# TimerHub

Gestionnaire de timers pour les quêtes journalières et hebdomadaires de tes jeux, les ouvertures de boosters, etc.
L'app PC (Electron) et la version téléphone (app web installable) partagent le même code, dans `web/`.

## Installer l'app PC
Lance `dist\TimerHub Setup 1.0.0.exe`. L'installateur n'est pas signé : si Windows SmartScreen s'affiche, clique sur
**Informations complémentaires → Exécuter quand même**.

## Activer la synchro PC ↔ téléphone (Supabase)
1. Dans Supabase, ouvre **SQL Editor → New query**, colle le contenu de `supabase/schema.sql`, puis clique sur **Run**.
2. Dans **Project Settings → API Keys**, copie la clé **anon / publishable** et colle-la dans `web/config.js`
   (`supabaseAnonKey`). Ne mets jamais la clé `service_role` ici.
3. Reconstruis l'installateur (`npm run dist`) et réinstalle-le.
4. Dans l'app, ouvre **Paramètres → Créer un compte**. Supabase envoie un e-mail de confirmation par défaut
   (désactivable dans **Authentication → Sign In / Providers → Email → Confirm email**).

## Validation des inscriptions (administration)
- Chaque nouveau compte est **en attente** : il ne peut rien lire ni écrire tant qu'il n'est pas validé
  (bloqué par les règles de la base, pas seulement par l'app).
- Le compte administrateur (**ruby**) voit un onglet **Admin** avec le nombre d'inscriptions en attente :
  Valider, Refuser (supprime le compte), Retirer l'accès, Supprimer.
- La personne validée voit sa page se débloquer automatiquement.

## Version téléphone
1. Crée un compte gratuit sur netlify.com, puis va dans **Sites → Add new site → Deploy manually**.
2. Glisse-dépose le dossier `web` (il doit contenir `vendor/supabase.js`, créé par `npm install`).
3. Ouvre l'adresse obtenue sur ton téléphone, puis :
   - Android (Chrome) : menu ⋮ → **Ajouter à l'écran d'accueil** ;
   - iPhone (Safari) : bouton Partager → **Sur l'écran d'accueil**.
4. Connecte-toi avec le même compte que sur le PC.

À chaque modification de `web/`, redépose le dossier sur Netlify.

## Utilisation
- **Journalière / Hebdomadaire** : la case se décoche toute seule à l'heure (et au jour) de reset choisis.
- **Timer** : cocher la case relance le compte à rebours à partir de maintenant (ex. toutes les 8 h).
  Recocher annule la dernière validation.
- **Bouton « Lancer »** en bas de la fiche : ID Steam (`steam://rungameid/ID`), programme `.exe`/raccourci, ou page web.
  Le reste de la fiche ne lance rien.
- **Onglet Rangement** : toutes les tâches classées par dossier. Crée des dossiers, clique sur l'en-tête pour
  ouvrir/fermer un dossier (« Tout ouvrir » / « Tout fermer » en haut), glisse une fiche vers un dossier pour l'y ranger
  (ou choisis le dossier dans la fiche). L'état ouvert/fermé est mémorisé sur chaque appareil.
- **Image Steam** : avec un ID Steam, le bouton « Image Steam » récupère la bannière du jeu.
- `Ctrl+N` : nouvelle tâche.
- Fermer la fenêtre la réduit près de l'horloge (réglable dans les Paramètres), donc les timers et les notifications continuent.

## Mises à jour
L'app PC vérifie les nouvelles versions sur
[GitHub Releases](https://github.com/Distopiary/TimerHub/releases) au démarrage puis toutes les 6 h,
les télécharge en arrière-plan et propose « Redémarrer et mettre à jour » (sinon installation à la fermeture).

Publier une nouvelle version (après tes modifications) :
```powershell
.\scripts\release.ps1 1.0.1
```
Le script met à jour le numéro de version, construit l'installateur, le publie sur GitHub, puis commit et pousse le code.
Pense à redéposer le dossier `web` sur Netlify si l'interface a changé.

## Développement
```powershell
npm install        # dépendances + copie de supabase.js dans web/vendor
npm start          # lance l'app PC
npm run serve      # version web sur http://localhost:5173
npm run dist       # construit l'installateur dans dist/
```
