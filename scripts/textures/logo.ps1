# Convert the shared brand asset to an uncompressed, 32-bit TGA for WoW.
Add-Type -AssemblyName System.Drawing
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$source = [System.Drawing.Bitmap]::FromFile((Join-Path $root 'assets/wisp.png'))
$size = 128
$bitmap = [System.Drawing.Bitmap]::new($size, $size)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$graphics.DrawImage($source, 0, 0, $size, $size)
$graphics.Dispose()
$source.Dispose()
$destination = Join-Path $root 'addon/WispAI/Textures/Wisp.tga'
$writer = [System.IO.BinaryWriter]::new([System.IO.File]::Create($destination))
try {
    $header = [byte[]]::new(18)
    $header[2] = 2 # Uncompressed true-color image.
    $header[12] = $size
    $header[14] = $size
    $header[16] = 32
    $header[17] = 8 # Eight alpha bits, bottom-left origin.
    $writer.Write($header)
    for ($y = $size - 1; $y -ge 0; $y--) {
        for ($x = 0; $x -lt $size; $x++) {
            $pixel = $bitmap.GetPixel($x, $y)
            $writer.Write([byte[]]@($pixel.B, $pixel.G, $pixel.R, $pixel.A))
        }
    }
} finally {
    $writer.Dispose()
    $bitmap.Dispose()
}
