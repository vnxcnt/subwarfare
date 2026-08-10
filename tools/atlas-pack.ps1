param(
  [Parameter(Mandatory = $true)][string]$Modell,
  [Parameter(Mandatory = $true)][string]$Quelle
)
# Teil der Atlas-Pipeline (Aufruf über tools/atlas-build.py):
# croppt jedes Frame auf seine Alpha-Grenzen und packt alle 64 per
# Shelf-Layout in EIN Bild. Liegen in der Arbeitsliste Metadaten-Anker
# (ankerX/ankerY in Originalkoordinaten), werden sie in Crop-Koordinaten
# umgerechnet; sonst bleibt 0.5 stehen und atlas-build.py setzt das
# Fregatten-Muster ein.
Add-Type -AssemblyName System.Drawing
$arbeit = Get-Content (Join-Path $env:TEMP "$Modell-arbeit.json") -Encoding UTF8 | ConvertFrom-Json
$arbeit = $arbeit | Sort-Object index

$PAD = 4
$SPALTEN = 8

$frames = @()
foreach ($e in $arbeit) {
  $bmp = [System.Drawing.Bitmap]::FromFile((Join-Path $Quelle $e.datei))
  $minX = [int]::MaxValue; $maxX = -1; $minY = [int]::MaxValue; $maxY = -1
  for ($y = 0; $y -lt $bmp.Height; $y++) {
    for ($x = 0; $x -lt $bmp.Width; $x++) {
      if ($bmp.GetPixel($x, $y).A -gt 40) {
        if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }
        if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y }
      }
    }
  }
  $rect = New-Object System.Drawing.Rectangle($minX, $minY, ($maxX - $minX + 1), ($maxY - $minY + 1))
  $crop = $bmp.Clone($rect, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $bmp.Dispose()

  $ax = 0.5; $ay = 0.5
  if ($null -ne $e.PSObject.Properties['ankerX']) {
    $ax = [Math]::Round(($e.ankerX - $minX) / $rect.Width, 4)
    $ay = [Math]::Round(($e.ankerY - $minY) / $rect.Height, 4)
  }
  $frames += [pscustomobject]@{ index = $e.index; crop = $crop; w = $rect.Width; h = $rect.Height; ax = $ax; ay = $ay }
}

$positionen = @{}
$x = $PAD; $y = $PAD; $zeilenHoehe = 0; $atlasBreite = 0; $spalte = 0
foreach ($f in $frames) {
  if ($spalte -eq $SPALTEN) { $y += $zeilenHoehe + $PAD; $x = $PAD; $zeilenHoehe = 0; $spalte = 0 }
  $positionen[$f.index] = @($x, $y)
  $x += $f.w + $PAD
  if ($x -gt $atlasBreite) { $atlasBreite = $x }
  if ($f.h -gt $zeilenHoehe) { $zeilenHoehe = $f.h }
  $spalte++
}
$atlasHoehe = $y + $zeilenHoehe + $PAD

$atlas = New-Object System.Drawing.Bitmap($atlasBreite, $atlasHoehe, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = [System.Drawing.Graphics]::FromImage($atlas)
$g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
foreach ($f in $frames) {
  $p = $positionen[$f.index]
  $g.DrawImage($f.crop, $p[0], $p[1], $f.w, $f.h)
  $f.crop.Dispose()
}
$g.Dispose()

$zielDir = Join-Path (Split-Path $PSScriptRoot -Parent) "apps\client\src\assets\vessels\$Modell"
New-Item -ItemType Directory -Force $zielDir | Out-Null
$atlas.Save((Join-Path $zielDir "atlas.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$atlas.Dispose()

$out = foreach ($f in $frames) {
  $p = $positionen[$f.index]
  [pscustomobject]@{ index = $f.index; x = $p[0]; y = $p[1]; w = $f.w; h = $f.h; ax = $f.ax; ay = $f.ay }
}
@{ breite = $atlasBreite; hoehe = $atlasHoehe; frames = $out } | ConvertTo-Json -Depth 4 |
  Out-File -Encoding utf8 (Join-Path $env:TEMP "$Modell-atlas.json")
"Atlas ${atlasBreite}x${atlasHoehe} gepackt."
