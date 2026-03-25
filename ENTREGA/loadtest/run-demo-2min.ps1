param(
    [string]$BaseUrl = "http://localhost:5000",
    [string]$UserEmail = "admin@email.com",
    [string]$UserPassword = "admin",
    [string]$Username = "",
    [string]$KnownProblemUser = "james_pan@nopCommerce.com|james_pan",
    [string]$UserCredentials = "admin@email.com|admin|email;steve_gates@nopCommerce.com|steve_gates|email;arthur_holmes@nopCommerce.com|arthur_holmes|email;james_pan@nopCommerce.com|james_pan|email;brenda_lindgren@nopCommerce.com|brenda_lindgren|email;victoria_victoria@nopCommerce.com|victoria_victoria|email;",
    [string]$ProductId = "21",
    [string]$ProductQuantity = "1",
    [string]$ProductPage = "/",
    [string]$BillingAddressId = "",
    [string]$ShippingAddressId = "",
    [string]$ShippingOption = "",
    [string]$PaymentMethod = "Payments.Manual",
    [string]$ThinkTimeSeconds = "0.3",
    [string]$OrderRetryAttempts = "4",
    [string]$OrderRetryBackoffSeconds = "3",
    [string]$ErrorMode = "mixed",
    [string]$ErrorRate = "0.5",
    [string]$ErrorFixedCredentialIndex = "1"
)

$env:BASE_URL = $BaseUrl
$env:USER_EMAIL = $UserEmail
$env:USER_PASSWORD = $UserPassword
$env:USERNAME = $Username
$env:USER_CREDENTIALS = $UserCredentials
$env:PRODUCT_ID = $ProductId
$env:PRODUCT_QUANTITY = $ProductQuantity
$env:PRODUCT_PAGE = $ProductPage
$env:BILLING_ADDRESS_ID = $BillingAddressId
$env:SHIPPING_ADDRESS_ID = $ShippingAddressId
$env:SHIPPING_OPTION = $ShippingOption
$env:PAYMENT_METHOD = $PaymentMethod
$env:THINK_TIME_SECONDS = $ThinkTimeSeconds
$env:ORDER_RETRY_ATTEMPTS = $OrderRetryAttempts
$env:ORDER_RETRY_BACKOFF_SECONDS = $OrderRetryBackoffSeconds
$env:ERROR_MODE = $ErrorMode
$env:ERROR_RATE = $ErrorRate
$env:ERROR_FIXED_CREDENTIAL_INDEX = $ErrorFixedCredentialIndex

$credentialCount = 0
if ($UserCredentials)
{
    $credentialCount = (($UserCredentials -split ';') | Where-Object { $_.Trim() -ne '' }).Count
}

# Perfil de 2 minutos: 30s rampa + 1m sustentado + 30s desaceleracao
$targetVus = 8
if ($credentialCount -gt 0 -and $credentialCount -lt $targetVus)
{
    $targetVus = $credentialCount
}

$env:START_VUS = "1"
$env:STAGE_1_DURATION = "30s"
$env:STAGE_1_TARGET = "$targetVus"
$env:STAGE_2_DURATION = "1m"
$env:STAGE_2_TARGET = "$targetVus"
$env:STAGE_3_DURATION = "30s"
$env:STAGE_3_TARGET = "0"

Write-Host "Iniciando demo de 2 minutos com k6..." -ForegroundColor Cyan
Write-Host "BASE_URL=$env:BASE_URL" -ForegroundColor DarkGray
Write-Host "USER_EMAIL=$env:USER_EMAIL" -ForegroundColor DarkGray
Write-Host "KNOWN_PROBLEM_USER=$KnownProblemUser" -ForegroundColor DarkYellow
Write-Host "USER_CREDENTIALS=$env:USER_CREDENTIALS" -ForegroundColor DarkGray
Write-Host "PRODUCT_ID=$env:PRODUCT_ID" -ForegroundColor DarkGray
Write-Host "PAYMENT_METHOD=$env:PAYMENT_METHOD" -ForegroundColor DarkGray
Write-Host "ERROR_MODE=$env:ERROR_MODE | ERROR_RATE=$env:ERROR_RATE | ERROR_FIXED_CREDENTIAL_INDEX=$env:ERROR_FIXED_CREDENTIAL_INDEX" -ForegroundColor DarkGray
if ($credentialCount -gt 0)
{
    Write-Host "USER_CREDENTIALS_COUNT=$credentialCount | TARGET_VUS=$targetVus" -ForegroundColor DarkGray
}

$k6Command = Get-Command k6 -ErrorAction SilentlyContinue
if (-not $k6Command)
{
    Write-Host "k6 nao foi encontrado no PATH." -ForegroundColor Red
    Write-Host "Instala com uma destas opcoes e volta a executar:" -ForegroundColor Yellow
    Write-Host "  winget install --id GrafanaLabs.k6 -e" -ForegroundColor DarkGray
    Write-Host "  choco install k6" -ForegroundColor DarkGray
    Write-Host "  scoop install k6" -ForegroundColor DarkGray
    exit 1
}

$scriptPath = Join-Path $PSScriptRoot "checkout-opc.k6.js"
if (-not (Test-Path $scriptPath))
{
    Write-Host "Script k6 nao encontrado em: $scriptPath" -ForegroundColor Red
    exit 1
}

k6 run $scriptPath
