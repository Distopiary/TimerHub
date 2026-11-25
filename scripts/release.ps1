# Publie une nouvelle version de TimerHub sur GitHub Releases.
# Utilisation (depuis le dossier du projet) :  .\scripts\release.ps1 1.0.1
# Les apps installées détectent la mise à jour toutes seules (au démarrage puis toutes les 6 h).
param([Parameter(Mandatory = $true)][string]$Version)
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot)

if (git status --porcelain) { Write-Host "Des modifications ne sont pas commitées : elles seront incluses dans la version $Version." }

npm version $Version --no-git-tag-version --allow-same-version | Out-Null
$env:GH_TOKEN = (gh auth token)
npm run release
if ($LASTEXITCODE -ne 0) { throw "La publication a échoué." }

git add -A
git commit -m "Version $Version"
git tag "v$Version"
git push origin main --tags
Write-Host "Version $Version publiée : https://github.com/Distopiary/TimerHub/releases"
