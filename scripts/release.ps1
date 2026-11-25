# Publie une nouvelle version de TimerHub sur GitHub Releases.
# Utilisation (depuis le dossier du projet) :  .\scripts\release.ps1 1.0.2
# Les apps installées détectent la mise à jour toutes seules (au démarrage puis toutes les 6 h),
# et la version téléphone (GitHub Pages) se met à jour avec l'envoi du code.
param([Parameter(Mandatory = $true)][string]$Version)
Set-Location (Split-Path $PSScriptRoot)

function Assert-Ok($what) { if ($LASTEXITCODE -ne 0) { throw "Échec : $what" } }

# 1. Numéro de version + envoi du code (le tag de la release pointera sur ce commit)
npm version $Version --no-git-tag-version --allow-same-version | Out-Null; Assert-Ok 'npm version'
git add -A 2>$null; Assert-Ok 'git add'
git commit -q -m "Version $Version" 2>$null
git push -q origin main 2>$null; Assert-Ok 'git push'

# 2. Construction et publication de l'installateur
$env:GH_TOKEN = (gh auth token)
npm run release; Assert-Ok 'publication'

git fetch -q --tags origin 2>$null
Write-Host "Version $Version publiée : https://github.com/Distopiary/TimerHub/releases/tag/v$Version"
