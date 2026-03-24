import http from "k6/http";
import { check, fail, sleep } from "k6";
import exec from "k6/execution";

const BASE_URL = (__ENV.BASE_URL || "http://localhost:5000").replace(/\/$/, "");
const USER_EMAIL = __ENV.USER_EMAIL || "";
const USER_PASSWORD = __ENV.USER_PASSWORD || "";
const USERNAME = __ENV.USERNAME || "";
const USER_CREDENTIALS = __ENV.USER_CREDENTIALS || "";
const PRODUCT_ID = __ENV.PRODUCT_ID || "";
const PRODUCT_QUANTITY = Number(__ENV.PRODUCT_QUANTITY || "1");
const PRODUCT_PAGE = __ENV.PRODUCT_PAGE || "/";
const BILLING_ADDRESS_ID = __ENV.BILLING_ADDRESS_ID || "";
const SHIPPING_ADDRESS_ID = __ENV.SHIPPING_ADDRESS_ID || "";
const SHIPPING_OPTION = __ENV.SHIPPING_OPTION || "";
const PAYMENT_METHOD = __ENV.PAYMENT_METHOD || "";
const THINK_TIME_SECONDS = Number(__ENV.THINK_TIME_SECONDS || "0.5");
const DB_RETRY_ATTEMPTS = Number(__ENV.DB_RETRY_ATTEMPTS || "3");
const DB_RETRY_BACKOFF_SECONDS = Number(__ENV.DB_RETRY_BACKOFF_SECONDS || "0.4");
const ORDER_RETRY_ATTEMPTS = Number(__ENV.ORDER_RETRY_ATTEMPTS || "4");
const ORDER_RETRY_BACKOFF_SECONDS = Number(__ENV.ORDER_RETRY_BACKOFF_SECONDS || "3");
const ERROR_MODE = (__ENV.ERROR_MODE || "off").toLowerCase(); // off | cooldown | mixed
const ERROR_RATE = Number(__ENV.ERROR_RATE || "0.35");
const ERROR_FIXED_CREDENTIAL_INDEX = Number(__ENV.ERROR_FIXED_CREDENTIAL_INDEX || "1");

function clamp01(value) {
  if (Number.isNaN(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function shouldInjectError() {
  if (ERROR_MODE === "off") return false;
  const normalizedRate = clamp01(ERROR_RATE);
  if (normalizedRate <= 0) return false;
  if (normalizedRate >= 1) return true;

  // Deterministico por VU/iteracao para manter distribuicao estavel entre execucoes.
  const bucket = ((__VU * 7919 + __ITER * 104729) % 1000) / 1000;
  return bucket < normalizedRate;
}

function isCooldownErrorModeActive() {
  return ERROR_MODE === "cooldown" || ERROR_MODE === "mixed";
}

function getEffectiveThinkTimeSeconds() {
  if (isCooldownErrorModeActive() && shouldInjectError()) {
    return 0;
  }

  return THINK_TIME_SECONDS;
}

export const options = {
  scenarios: {
    checkout_flow: {
      executor: "ramping-vus",
      startVUs: Number(__ENV.START_VUS || "1"),
      stages: [
        { duration: __ENV.STAGE_1_DURATION || "30s", target: Number(__ENV.STAGE_1_TARGET || "2") },
        { duration: __ENV.STAGE_2_DURATION || "1m", target: Number(__ENV.STAGE_2_TARGET || "5") },
        { duration: __ENV.STAGE_3_DURATION || "30s", target: Number(__ENV.STAGE_3_TARGET || "0") }
      ],
      gracefulRampDown: "20s"
    }
  },
  thresholds: {
    http_req_failed: ["rate<0.10"],
    http_req_duration: ["p(95)<3000"]
  }
};

function htmlDecode(text) {
  if (!text) return "";
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function parseJson(response) {
  try {
    return response.json();
  } catch (err) {
    return null;
  }
}

function parseUserCredentials(raw) {
  if (!raw) return [];

  return raw
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((entry) => {
      const pieces = entry.split("|").map((p) => p.trim());
      if (pieces.length < 2) return null;

      const login = pieces[0] || "";
      const password = pieces[1] || "";
      const kind = (pieces[2] || "").toLowerCase();

      if (!login || !password) return null;

      if (kind === "username") {
        return { username: login, email: "", password, loginId: login, kind: "username" };
      }

      if (kind === "email") {
        return { username: "", email: login, password, loginId: login, kind: "email" };
      }

      if (login.includes("@")) {
        return { username: "", email: login, password, loginId: login, kind: "email" };
      }

      return { username: login, email: "", password, loginId: login, kind: "username" };
    })
    .filter((x) => x && x.password && (x.email || x.username));
}

function getCurrentCredential() {
  const parsed = parseUserCredentials(USER_CREDENTIALS);
  if (parsed.length) {
    const vuId = exec.vu && exec.vu.idInTest ? exec.vu.idInTest : 1;
    if (isCooldownErrorModeActive() && shouldInjectError()) {
      const fixedIndex = Math.min(Math.max(ERROR_FIXED_CREDENTIAL_INDEX - 1, 0), parsed.length - 1);
      const selected = parsed[fixedIndex];
      return { ...selected, credentialIndex: fixedIndex + 1, credentialCount: parsed.length, vuId };
    }

    const index = (vuId - 1) % parsed.length;
    const selected = parsed[index];
    return { ...selected, credentialIndex: index + 1, credentialCount: parsed.length, vuId };
  }

  return {
    email: USER_EMAIL,
    username: USERNAME,
    password: USER_PASSWORD,
    loginId: USER_EMAIL || USERNAME || "",
    kind: USER_EMAIL ? "email" : "username",
    credentialIndex: 1,
    credentialCount: 1,
    vuId: exec.vu && exec.vu.idInTest ? exec.vu.idInTest : 1
  };
}

function getCurrentLoginLabel() {
  const credential = getCurrentCredential();
  return credential.email || credential.username || credential.loginId || "(sem-usuario)";
}

function getCurrentCredentialContextLabel() {
  const credential = getCurrentCredential();
  const login = credential.email || credential.username || credential.loginId || "(sem-usuario)";
  const kind = credential.kind || (credential.email ? "email" : "username");
  return "vu=" + credential.vuId + ", cred=" + credential.credentialIndex + "/" + credential.credentialCount + ", " + kind + "=" + login;
}

function isOrderCooldownMessage(message) {
  const msg = (message || "").toLowerCase();
  return msg.includes("please wait several seconds before placing a new order");
}

function extractAntiForgeryToken(html) {
  if (!html) return "";

  const regexes = [
    /name="__RequestVerificationToken"\s+type="hidden"\s+value="([^"]+)"/i,
    /name="__RequestVerificationToken"\s+value="([^"]+)"/i,
    /value="([^"]+)"\s+name="__RequestVerificationToken"/i
  ];

  for (const re of regexes) {
    const match = html.match(re);
    if (match && match[1]) return htmlDecode(match[1]);
  }

  return "";
}

function extractOptionValueByInputName(html, inputName) {
  if (!html) return "";
  const escaped = inputName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp('name="' + escaped + '"[^>]*value="([^"]+)"', "i");
  const match = html.match(re);
  return match && match[1] ? htmlDecode(match[1]) : "";
}

function extractFirstOptionValueBySelectName(html, selectName) {
  if (!html) return "";
  const escaped = selectName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const selectRe = new RegExp('<select[^>]*name="' + escaped + '"[^>]*>([\\s\\S]*?)<\\/select>', "i");
  const selectMatch = html.match(selectRe);
  if (!selectMatch || !selectMatch[1]) return "";

  const optionRe = /<option[^>]*value="([^"]*)"[^>]*>/gi;
  let optionMatch;
  while ((optionMatch = optionRe.exec(selectMatch[1])) !== null) {
    const val = htmlDecode(optionMatch[1] || "").trim();
    if (val) return val;
  }

  return "";
}

function extractCheckoutAttributeSelections(html) {
  const data = {};
  if (!html) return data;

  // Selects: checkout_attribute_{id}
  const selectRe = /<select[^>]*name=['"](checkout_attribute_\d+)['"][^>]*>([\s\S]*?)<\/select>/gi;
  let selectMatch;
  while ((selectMatch = selectRe.exec(html)) !== null) {
    const name = selectMatch[1];
    const optionsHtml = selectMatch[2] || "";

    let selectedValue = "";

    // Tenta primeiro option marcado como selected e diferente de 0
    const selectedOptRe = /<option[^>]*selected[^>]*value=['"]([^'"]*)['"][^>]*>|<option[^>]*value=['"]([^'"]*)['"][^>]*selected[^>]*>/gi;
    let sMatch;
    while ((sMatch = selectedOptRe.exec(optionsHtml)) !== null) {
      const val = htmlDecode((sMatch[1] || sMatch[2] || "").trim());
      if (val && val !== "0") {
        selectedValue = val;
        break;
      }
    }

    // Se nao houver selected valido, pega o primeiro diferente de 0
    if (!selectedValue) {
      const optionRe = /<option[^>]*value=['"]([^'"]*)['"][^>]*>/gi;
      let oMatch;
      while ((oMatch = optionRe.exec(optionsHtml)) !== null) {
        const val = htmlDecode((oMatch[1] || "").trim());
        if (val && val !== "0") {
          selectedValue = val;
          break;
        }
      }
    }

    if (selectedValue) {
      data[name] = selectedValue;
    }
  }

  // Radio buttons: checkout_attribute_{id}
  const radiosByName = {};
  const radioRe = /<input[^>]*type=['"]radio['"][^>]*name=['"](checkout_attribute_\d+)['"][^>]*>/gi;
  let radioMatch;
  while ((radioMatch = radioRe.exec(html)) !== null) {
    const inputHtml = radioMatch[0] || "";
    const name = radioMatch[1];
    const valueMatch = inputHtml.match(/value=['"]([^'"]*)['"]/i);
    const value = valueMatch ? htmlDecode((valueMatch[1] || "").trim()) : "";
    const checked = /\schecked(\s|=|>)/i.test(inputHtml);
    if (!value) continue;

    if (!radiosByName[name]) radiosByName[name] = { checked: "", first: "" };
    if (!radiosByName[name].first) radiosByName[name].first = value;
    if (checked) radiosByName[name].checked = value;
  }

  Object.keys(radiosByName).forEach((name) => {
    if (!data[name]) {
      data[name] = radiosByName[name].checked || radiosByName[name].first;
    }
  });

  return data;
}

function extractFirstAddressId(html, selectName) {
  if (!html) return "";

  const escaped = selectName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // Alguns temas/plugins renderizam como input hidden em vez de select.
  const inputRe = new RegExp('<input[^>]*name=[\'\"]' + escaped + '[\'\"][^>]*value=[\'\"]([^\'\"]+)[\'\"][^>]*>', "i");
  const inputMatch = html.match(inputRe);
  if (inputMatch && inputMatch[1] && inputMatch[1] !== "0") {
    return htmlDecode(inputMatch[1]);
  }

  const selectRe = new RegExp('<select[^>]*name=[\'\"]' + escaped + '[\'\"][^>]*>([\\s\\S]*?)<\\/select>', "i");
  let selectMatch = html.match(selectRe);

  // Fallback adicional: alguns temas podem renderizar sem atributo name, mas com id conhecido.
  if (!selectMatch && selectName === "billing_address_id") {
    selectMatch = html.match(/<select[^>]*id=['"]billing-address-select['"][^>]*>([\s\S]*?)<\/select>/i);
  }
  if (!selectMatch && selectName === "shipping_address_id") {
    selectMatch = html.match(/<select[^>]*id=['"]shipping-address-select['"][^>]*>([\s\S]*?)<\/select>/i);
  }

  if (!selectMatch || !selectMatch[1]) return "";

  // Tenta primeiro a option marcada como selected.
  const selectedRe = /<option[^>]*selected[^>]*value=['"]([^'"]+)['"][^>]*>|<option[^>]*value=['"]([^'"]+)['"][^>]*selected[^>]*>/gi;
  let selectedMatch;
  while ((selectedMatch = selectedRe.exec(selectMatch[1])) !== null) {
    const selectedValue = htmlDecode((selectedMatch[1] || selectedMatch[2] || "").trim());
    if (selectedValue && selectedValue !== "0") return selectedValue;
  }

  const optionRe = /<option[^>]*value=['"]([^'"]+)['"][^>]*>/gi;
  let optionMatch;
  while ((optionMatch = optionRe.exec(selectMatch[1])) !== null) {
    const value = htmlDecode((optionMatch[1] || "").trim());
    if (value && value !== "0") return value;
  }

  return "";
}

function buildPostParams(token) {
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded",
    "X-Requested-With": "XMLHttpRequest"
  };

  if (token) headers.RequestVerificationToken = token;
  return { headers, redirects: 0 };
}

function updateTokenFromHtml(currentToken, html) {
  const found = extractAntiForgeryToken(html);
  return found || currentToken;
}

function getLocationHeader(response) {
  if (!response || !response.headers) return "";
  return response.headers.Location || response.headers.location || "";
}

function isDeadlockMessage(msg) {
  return (msg || "").toLowerCase().includes("deadlock victim");
}

function extractErrorMessage(json) {
  if (!json) return "sem payload";
  if (typeof json.message === "string" && json.message) return json.message;
  if (Array.isArray(json.Errors) && json.Errors.length) return json.Errors.join(" | ");
  if (Array.isArray(json.errors) && json.errors.length) return json.errors.join(" | ");
  if (Array.isArray(json.Warnings) && json.Warnings.length) return json.Warnings.join(" | ");
  if (Array.isArray(json.warnings) && json.warnings.length) return json.warnings.join(" | ");
  return "sem mensagem";
}

function selectPaymentMethod(token, sectionHtml) {
  const paymentMethodValue = PAYMENT_METHOD || extractOptionValueByInputName(sectionHtml || "", "paymentmethod");
  if (!paymentMethodValue) {
    fail("Nao foi possivel determinar paymentmethod. Defina PAYMENT_METHOD.");
  }

  const paymentMethodRes = http.post(
    BASE_URL + "/checkout/OpcSavePaymentMethod",
    {
      __RequestVerificationToken: token,
      paymentmethod: paymentMethodValue,
      UseRewardPoints: "false"
    },
    buildPostParams(token)
  );

  check(paymentMethodRes, { "OpcSavePaymentMethod 200": (r) => r.status === 200 });
  const paymentMethodJson = parseJson(paymentMethodRes);
  if (!paymentMethodJson) fail("OpcSavePaymentMethod nao retornou JSON valido.");

  if (paymentMethodJson.error) {
    fail("OpcSavePaymentMethod retornou erro: " + (paymentMethodJson.message || "sem mensagem"));
  }

  return paymentMethodJson;
}

function saveCheckoutAttributes(token, sectionHtml) {
  let attrs = extractCheckoutAttributeSelections(sectionHtml);
  let names = Object.keys(attrs);

  // Fallback: em alguns fluxos OPC o HTML da etapa nao inclui controles de checkout attributes.
  if (!names.length) {
    const cartRes = http.get(BASE_URL + "/cart", { redirects: 0 });
    if (cartRes.status === 200) {
      attrs = extractCheckoutAttributeSelections(cartRes.body || "");
      names = Object.keys(attrs);
    }
  }

  if (!names.length) {
    return false;
  }

  const payload = {
    __RequestVerificationToken: token,
    ...attrs
  };

  const res = http.post(
    BASE_URL + "/shoppingcart/checkoutattributechange/true",
    payload,
    buildPostParams(token)
  );

  check(res, { "CheckoutAttributeChange 200": (r) => r.status === 200 });
  const json = parseJson(res);
  if (!json) return false;

  return true;
}

function login() {
  const credential = getCurrentCredential();

  if (!credential.password || (!credential.email && !credential.username)) {
    fail("Define USER_EMAIL/USERNAME + USER_PASSWORD ou USER_CREDENTIALS para executar checkout autenticado.");
  }

  const loginPage = http.get(BASE_URL + "/login", { redirects: 0 });
  check(loginPage, { "login page abriu": (r) => r.status === 200 });

  let token = extractAntiForgeryToken(loginPage.body);
  if (!token) fail("Nao foi possivel extrair __RequestVerificationToken da pagina de login.");

  const payload = {
    __RequestVerificationToken: token,
    CheckOutAsGuest: "false",
    RememberMe: "false",
    returnUrl: ""
  };

  if (credential.username) payload.Username = credential.username;
  if (credential.email) payload.Email = credential.email;
  payload.Password = credential.password;

  const res = http.post(BASE_URL + "/login", payload, {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    redirects: 0
  });

  const location = getLocationHeader(res);
  check(res, {
    "login sem erro 500": (r) => r.status !== 500,
    "login concluido ou redirecionou": (r) => r.status === 200 || r.status === 302 || r.status === 303
  });

  // Quando usernames estao ativos ou credenciais estao erradas, o nop retorna 200 na propria pagina de login.
  if (res.status === 200) {
    const loginPageSignature = (res.body || "").includes("page login-page") || (res.body || "").includes("name=\"Email\"") || (res.body || "").includes("name=\"Username\"");
    if (loginPageSignature) {
      fail("Login aparenta ter falhado (resposta 200 da pagina de login). Verifica USER_EMAIL/USERNAME, USER_PASSWORD ou USER_CREDENTIALS.");
    }
  }

  if ((res.status === 302 || res.status === 303) && location.toLowerCase().includes("/login")) {
    fail("Login redirecionou novamente para /login. Credenciais invalidas ou formato incorreto (email vs username).");
  }

  return token;
}

function addProductToCart(token) {
  if (!PRODUCT_ID) {
    return token;
  }

  const productPageRes = http.get(BASE_URL + PRODUCT_PAGE, { redirects: 0 });
  check(productPageRes, { "product page abriu": (r) => r.status === 200 || r.status === 302 });

  token = updateTokenFromHtml(token, productPageRes.body);

  const payload = {
    __RequestVerificationToken: token
  };

  const addUrl = BASE_URL + "/addproducttocart/catalog/" + PRODUCT_ID + "/1/" + PRODUCT_QUANTITY;
  const res = http.post(addUrl, payload, buildPostParams(token));

  check(res, {
    "add to cart respondeu": (r) => r.status === 200
  });

  if (res.status !== 200) {
    const location = getLocationHeader(res);
    fail("AddToCart retornou status " + res.status + (location ? ", location=" + location : "") + ".");
  }

  const addJson = parseJson(res);
  if (!addJson) {
    fail("AddToCart nao retornou JSON valido.");
  }

  if (addJson) {
    if (addJson.success === false) {
      fail("AddToCart falhou: " + (addJson.message || "sem mensagem"));
    }

    // Em varios cenarios o nop retorna redirect para pagina de detalhes quando nao consegue adicionar pelo endpoint catalog.
    if (addJson.redirect && !(addJson.success === true)) {
      fail("AddToCart retornou redirect (produto nao adicionado pelo endpoint catalog): " + addJson.redirect);
    }

    if (addJson.success !== true) {
      fail("AddToCart nao confirmou sucesso. mensagem=" + (addJson.message || "sem mensagem"));
    }
  }

  return token;
}

function runCheckoutOpc(token) {
  const effectiveThinkTimeSeconds = getEffectiveThinkTimeSeconds();

  let response = http.get(BASE_URL + "/onepagecheckout", { redirects: 0 });

  // Segue redirecionamentos manualmente para diagnosticar para onde o fluxo esta indo.
  for (let i = 0; i < 4 && (response.status === 301 || response.status === 302 || response.status === 303 || response.status === 307 || response.status === 308); i++) {
    const location = getLocationHeader(response);
    if (!location) break;

    const nextUrl = location.startsWith("http") ? location : BASE_URL + (location.startsWith("/") ? location : "/" + location);
    response = http.get(nextUrl, { redirects: 0 });
  }

  check(response, {
    "onepage checkout abriu": (r) => r.status === 200
  });

  if (response.status !== 200) {
    const location = getLocationHeader(response);
    fail("OnePageCheckout nao abriu com 200. status=" + response.status + (location ? ", location=" + location : ""));
  }

  const html = response.body || "";
  const isRealCheckoutPage =
    html.includes("id=\"checkout-steps\"") ||
    html.includes("class=\"page checkout-page\"") ||
    html.includes("/checkout/OpcSaveBilling/") ||
    html.includes("co-billing-form");

  if (!isRealCheckoutPage) {
    const looksLikeCart = html.includes("shopping-cart-page") || html.includes("/cart/") || html.includes("name=\"updatecart\"");
    fail("Resposta 200 mas nao e a pagina de OnePageCheckout" + (looksLikeCart ? " (parece carrinho vazio/redirect para cart)." : "."));
  }

  token = updateTokenFromHtml(token, html);

  const billingAddressId = BILLING_ADDRESS_ID || extractFirstAddressId(html, "billing_address_id");
  if (!billingAddressId) {
    fail("Nao foi possivel determinar billing_address_id para usuario " + getCurrentLoginLabel() + " (" + getCurrentCredentialContextLabel() + "). Defina BILLING_ADDRESS_ID.");
  }

  sleep(effectiveThinkTimeSeconds);

  let billingRes = http.post(
    BASE_URL + "/checkout/OpcSaveBilling",
    {
      __RequestVerificationToken: token,
      billing_address_id: billingAddressId,
      ShipToSameAddress: "true"
    },
    buildPostParams(token)
  );

  check(billingRes, { "OpcSaveBilling 200": (r) => r.status === 200 });
  let billingJson = parseJson(billingRes);
  if (!billingJson) fail("OpcSaveBilling nao retornou JSON valido.");

  let sectionHtml = billingJson.update_section && billingJson.update_section.html ? billingJson.update_section.html : "";
  token = updateTokenFromHtml(token, sectionHtml);

  if (billingJson.error || billingJson.wrong_billing_address) {
    fail("OpcSaveBilling retornou erro: " + (billingJson.message || "sem mensagem"));
  }

  sleep(effectiveThinkTimeSeconds);

  let currentJson = billingJson;

  if (currentJson.goto_section === "shipping") {
    const shippingAddressId = SHIPPING_ADDRESS_ID || extractFirstAddressId(sectionHtml, "shipping_address_id");
    if (!shippingAddressId) {
      fail("Nao foi possivel determinar shipping_address_id. Defina SHIPPING_ADDRESS_ID.");
    }

    const shippingRes = http.post(
      BASE_URL + "/checkout/OpcSaveShipping",
      {
        __RequestVerificationToken: token,
        shipping_address_id: shippingAddressId
      },
      buildPostParams(token)
    );

    check(shippingRes, { "OpcSaveShipping 200": (r) => r.status === 200 });
    currentJson = parseJson(shippingRes);
    if (!currentJson) fail("OpcSaveShipping nao retornou JSON valido.");

    if (currentJson.error) {
      fail("OpcSaveShipping retornou erro: " + (currentJson.message || "sem mensagem"));
    }

    sectionHtml = currentJson.update_section && currentJson.update_section.html ? currentJson.update_section.html : "";
    token = updateTokenFromHtml(token, sectionHtml);
    sleep(effectiveThinkTimeSeconds);
  }

  if (currentJson.goto_section === "shipping_method") {
    const shippingOptionValue = SHIPPING_OPTION || extractOptionValueByInputName(sectionHtml, "shippingoption");
    if (!shippingOptionValue) {
      fail("Nao foi possivel determinar shippingoption. Defina SHIPPING_OPTION.");
    }

    let shippingSaved = false;
    for (let attempt = 1; attempt <= DB_RETRY_ATTEMPTS; attempt++) {
      const shipMethodRes = http.post(
        BASE_URL + "/checkout/OpcSaveShippingMethod",
        {
          __RequestVerificationToken: token,
          shippingoption: shippingOptionValue
        },
        buildPostParams(token)
      );

      check(shipMethodRes, { "OpcSaveShippingMethod 200": (r) => r.status === 200 });
      currentJson = parseJson(shipMethodRes);
      if (!currentJson) fail("OpcSaveShippingMethod nao retornou JSON valido.");

      if (!currentJson.error) {
        shippingSaved = true;
        break;
      }

      const msg = extractErrorMessage(currentJson);
      if (isDeadlockMessage(msg) && attempt < DB_RETRY_ATTEMPTS) {
        sleep(DB_RETRY_BACKOFF_SECONDS * attempt);
        continue;
      }

      fail("OpcSaveShippingMethod retornou erro: " + msg);
    }

    if (!shippingSaved) {
      fail("OpcSaveShippingMethod falhou apos retries.");
    }

    sectionHtml = currentJson.update_section && currentJson.update_section.html ? currentJson.update_section.html : "";
    token = updateTokenFromHtml(token, sectionHtml);
    sleep(effectiveThinkTimeSeconds);
  }

  if (currentJson.goto_section === "payment_method") {
    currentJson = selectPaymentMethod(token, sectionHtml);

    sectionHtml = currentJson.update_section && currentJson.update_section.html ? currentJson.update_section.html : "";
    token = updateTokenFromHtml(token, sectionHtml);
    sleep(effectiveThinkTimeSeconds);
  }

  if (currentJson.goto_section === "payment_info") {
    const sendPaymentInfo = () => {
      const creditCardType = extractFirstOptionValueBySelectName(sectionHtml, "CreditCardType") || "Visa";
      const expireMonth = extractFirstOptionValueBySelectName(sectionHtml, "ExpireMonth") || "12";
      const expireYear = String(new Date().getFullYear() + 2);

      const paymentInfoRes = http.post(
        BASE_URL + "/checkout/OpcSavePaymentInfo",
        {
          __RequestVerificationToken: token,
          CreditCardType: creditCardType,
          CardholderName: "Load Test",
          CardNumber: "4868719196829038",
          ExpireMonth: expireMonth,
          ExpireYear: expireYear,
          CardCode: "344"
        },
        buildPostParams(token)
      );

      check(paymentInfoRes, { "OpcSavePaymentInfo 200": (r) => r.status === 200 });
      const paymentInfoJson = parseJson(paymentInfoRes);
      if (!paymentInfoJson) fail("OpcSavePaymentInfo nao retornou JSON valido.");
      return paymentInfoJson;
    };

    currentJson = sendPaymentInfo();

    if (currentJson.error && (currentJson.message || "").includes("Payment method is not selected")) {
      // Alguns caminhos OPC pulam visualmente a etapa, mas exigem seleção explícita.
      currentJson = selectPaymentMethod(token, sectionHtml);
      sectionHtml = currentJson.update_section && currentJson.update_section.html ? currentJson.update_section.html : sectionHtml;
      token = updateTokenFromHtml(token, sectionHtml);
      currentJson = sendPaymentInfo();
    }

    if (currentJson.error) {
      fail("OpcSavePaymentInfo retornou erro: " + (currentJson.message || "sem mensagem"));
    }

    sectionHtml = currentJson.update_section && currentJson.update_section.html ? currentJson.update_section.html : "";
    token = updateTokenFromHtml(token, sectionHtml);
    sleep(effectiveThinkTimeSeconds);
  }

  const postConfirmOrder = (checkLabel) => {
    const res = http.post(
      BASE_URL + "/checkout/OpcConfirmOrder?captchaValid=true",
      {
        __RequestVerificationToken: token
      },
      buildPostParams(token)
    );

    check(res, {
      [checkLabel]: (r) => r.status === 200
    });

    return parseJson(res);
  };

  let finalConfirmJson = postConfirmOrder("OpcConfirmOrder 200");
  if (!finalConfirmJson) fail("OpcConfirmOrder nao retornou JSON valido.");

  if (!(finalConfirmJson.success === 1 || finalConfirmJson.success === true)) {
    const msg = extractErrorMessage(finalConfirmJson);
    const needsCheckoutAttribute = (msg || "").toLowerCase().includes("please select");

    if (needsCheckoutAttribute && saveCheckoutAttributes(token, sectionHtml)) {
      const retryJson = postConfirmOrder("OpcConfirmOrder retry 200");
      if (retryJson) {
        finalConfirmJson = retryJson;
      }
    }
  }

  if (!(finalConfirmJson.success === 1 || finalConfirmJson.success === true)) {
    const effectiveOrderRetryAttempts = isCooldownErrorModeActive() && shouldInjectError() ? 0 : ORDER_RETRY_ATTEMPTS;
    for (let attempt = 1; attempt <= effectiveOrderRetryAttempts; attempt++) {
      const retryMsg = extractErrorMessage(finalConfirmJson);
      if (!isOrderCooldownMessage(retryMsg)) {
        break;
      }

      sleep(ORDER_RETRY_BACKOFF_SECONDS);
      const retryJson = postConfirmOrder("OpcConfirmOrder cooldown retry 200");
      if (!retryJson) {
        break;
      }

      finalConfirmJson = retryJson;
      if (finalConfirmJson.success === 1 || finalConfirmJson.success === true) {
        break;
      }
    }
  }

  if (!(finalConfirmJson.success === 1 || finalConfirmJson.success === true)) {
    fail("Pedido nao confirmado: " + extractErrorMessage(finalConfirmJson));
  }

  check(finalConfirmJson, {
    "pedido confirmado": (j) => j.success === 1 || j.success === true
  });
}

export default function () {
  if (__ITER === 0 && __VU === 1) {
    console.log("[k6] ERROR_MODE=" + ERROR_MODE + ", ERROR_RATE=" + clamp01(ERROR_RATE));
  }

  const effectiveThinkTimeSeconds = getEffectiveThinkTimeSeconds();
  const home = http.get(BASE_URL + "/", { redirects: 0 });
  check(home, { "home respondeu": (r) => r.status === 200 || r.status === 302 });

  let token = extractAntiForgeryToken(home.body);

  token = login() || token;
  token = addProductToCart(token);
  runCheckoutOpc(token);

  sleep(effectiveThinkTimeSeconds);
}
