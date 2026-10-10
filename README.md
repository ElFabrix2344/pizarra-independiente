# Pizarra semanal

Panel personal que reúne la agenda de **Google Calendar** y las tareas de **TickTick**: la semana agrupada por día, el evento en curso o el siguiente con cuenta regresiva, las tareas vencidas, de hoy y de la semana, las próximas evaluaciones y un botón «Hecha» para completar tareas. Funciona en la laptop y en el celular (se puede instalar como app desde el navegador).

Nació como artifact de claude.ai. Esta versión es independiente: un **Cloudflare Worker** que sirve el frontend estático y una API pequeña, protegidos con **Cloudflare Access**.

```
Navegador ──► Cloudflare Access (login con tu correo) ──► Worker
                                                         ├─ /             public/ (HTML, CSS, JS)
                                                         ├─ /api/*        Google Calendar y TickTick
                                                         ├─ /oauth/*      conexión de cuentas (una vez)
                                                         └─ KV "TOKENS"   tokens cifrados (AES-GCM)
```

- Zona horaria fija: `America/Lima`. Interfaz en español.
- Se actualiza sola cada 5 minutos (y al volver a la pestaña). Si una fuente falla, solo esa sección muestra el error y conserva los últimos datos buenos.
- Ningún secreto en el frontend ni en el repo: las credenciales viven en los secretos del Worker y los tokens en KV, cifrados.

## API

Todas las rutas exigen sesión de Cloudflare Access.

| Método | Ruta | Qué hace |
|---|---|---|
| GET | `/api/calendar` | Eventos del calendario principal, de hoy a +7 días |
| GET | `/api/tasks` | Tareas de TickTick sin completar: vencidas (últimos 7 días), de hoy y de la semana |
| GET | `/api/evaluations?limit=6` | Tareas de hoy a +70 días cuyo título es una evaluación (PC, Parcial, Examen, Entrega…) |
| POST | `/api/tasks/:projectId/:taskId/complete` | Marca la tarea como completada (requiere cabecera `X-Pizarra: 1` y mismo origen) |
| GET | `/api/status` | Qué cuentas están conectadas y comprobación de formato de las credenciales (sin mostrar secretos) |
| GET | `/api/debug/ticktick` | Diagnóstico: compara las dos estrategias de lectura de TickTick y muestra los campos reales |
| GET | `/oauth/google/start`, `/oauth/ticktick/start` | Conectan cada cuenta (OAuth) |

Los errores tienen la forma `{ "error": { "code", "message", "provider" } }`, con `code` igual a `not_connected`, `reauth_required`, `upstream_error`, `bad_response`, `bad_request`, `forbidden` o `misconfigured`.

## Estructura

```
src/
  index.ts              router, validación de Access, cabeceras de seguridad
  auth/access.ts        verificación del JWT de Cloudflare Access (jose)
  oauth.ts              /oauth/{google,ticktick}/{start,callback}
  providers.ts          clientes autenticados a partir de los tokens guardados
  store.ts              tokens en KV, cifrados
  services/tasks.ts     reglas del panel para TickTick (vencidas, semana, evaluaciones)
  services/calendar.ts  reglas del panel para Calendar
  lib/ticktick/         ← cliente reutilizable de la TickTick Open API (sin dependencias del panel)
  lib/google.ts         OAuth de Google y Calendar API v3
  lib/time.ts           utilidades de fecha por zona horaria
  mock.ts               datos inventados para desarrollo local
public/                 frontend (HTML, CSS, JS sin framework) y privacy.html (política de privacidad)
test/                   pruebas (vitest)
```

`src/lib/ticktick/` es independiente: recibe una función que devuelve el access token y no sabe nada de KV ni de Cloudflare. Se puede copiar o importar en otro proyecto (por ejemplo, para crear tareas a partir de un sílabo).

---

## Configuración paso a paso

Necesitas Node.js 22.12 o superior. Abre una terminal en la carpeta del proyecto:

```bash
npm install
```

> **Windows / PowerShell.** Si `npx` falla con un error de *execution policy* («la ejecución de scripts está deshabilitada»), usa `npx.cmd` en su lugar (`npx.cmd wrangler login`, etc.). No hace falta cambiar la política de seguridad de Windows.

### 1. Cloudflare: cuenta, KV y primer despliegue

1. Crea una cuenta gratuita en <https://dash.cloudflare.com/sign-up> e inicia sesión desde la terminal:
   ```bash
   npx wrangler login
   ```
2. Crea el namespace de KV para los tokens:
   ```bash
   npx wrangler kv namespace create TOKENS
   ```
   Copia el `id` que devuelve y pégalo en `wrangler.jsonc`, en lugar de `REEMPLAZA_CON_EL_ID_DEL_NAMESPACE`. El id no es secreto.
3. Despliega por primera vez para obtener la URL:
   ```bash
   npx wrangler deploy
   ```
   La URL será `https://pizarra-semanal.<tu-subdominio>.workers.dev`. Si la cuenta aún no tenía subdominio de `workers.dev`, wrangler registra uno automáticamente (puede tardar unos minutos en responder). Mientras Access no esté configurado, el Worker **no sirve nada** (responde 503): falla cerrado.

### 2. Cloudflare Access (quién puede entrar)

1. En el dashboard: **Workers & Pages → pizarra-semanal → Settings → Domains & Routes**. En la fila de `workers.dev`, pulsa **Enable Cloudflare Access**. Si es la primera vez, Cloudflare te pedirá crear tu organización de Zero Trust (plan Free) y elegir un *team name*.
2. Pulsa **Manage Cloudflare Access** y deja en la política **solo tu correo**. El método de login por defecto es un código de un solo uso enviado al correo; si quieres, en Zero Trust → Settings → Authentication puedes agregar "Google" como método.
3. Anota dos valores:
   - **Team domain**: aparece en la configuración de Zero Trust (Settings, como *Team domain*) y también es el dominio de la página de login de Access. Tiene la forma `https://<team>.cloudflareaccess.com`.
   - **AUD tag**: Zero Trust → Access → Applications → la aplicación del Worker → *Application Audience (AUD) Tag*.
4. (Recomendado) En Zero Trust → Access → Applications → la aplicación → *Session duration*, elige algo como 1 mes para no tener que iniciar sesión a cada rato en el celular.

El Worker valida además el JWT de Access en cada petición (firma, `aud` e `iss`) y comprueba que el correo esté en `ALLOWED_EMAILS`.

### 3. Google Cloud (Calendar, solo lectura)

1. Entra a <https://console.cloud.google.com/>, crea un proyecto (p. ej. "pizarra-semanal") y selecciónalo.
2. **APIs y servicios → Biblioteca →** busca *Google Calendar API* → **Habilitar**.
3. **Google Auth Platform** (o "Pantalla de consentimiento de OAuth"):
   - **Branding**: Google exige estos campos para poder publicar la app:

     | Campo | Valor |
     |---|---|
     | Nombre de la app | `Pizarra semanal` |
     | Correo de asistencia | tu correo |
     | Logotipo | **vacío** (subir un logo obliga a verificar la marca) |
     | Página principal | `https://pizarra-semanal.<tu-subdominio>.workers.dev/` |
     | Política de privacidad | `https://pizarra-semanal.<tu-subdominio>.workers.dev/privacy` (incluida en `public/privacy.html`) |
     | Dominios autorizados | `<tu-subdominio>.workers.dev` (el dominio base, sin `pizarra-semanal.` delante) |
     | Correo del desarrollador | tu correo |

     Que esas URLs estén detrás de Access no es problema: Google no las abre para una app sin verificar.
   - **Data access**: agrega el scope `https://www.googleapis.com/auth/calendar.readonly`.
   - **Audience**: tipo **External**. Pulsa **Publish app** y confirma para pasar a **In production**. Si ofrece enviar la app a verificación, *no lo hagas*.
4. **Clients → Create client → Web application**. En *Authorized redirect URIs* agrega:
   - `https://pizarra-semanal.<tu-subdominio>.workers.dev/oauth/google/callback`
   - `http://localhost:8787/oauth/google/callback` (para desarrollo local)

   Guarda el **Client ID** (termina en `.apps.googleusercontent.com`) y el **Client secret** (empieza con `GOCSPX-`).

> **Por qué "In production" y no "Testing".** Con tipo External y estado *Testing*, Google emite refresh tokens que **vencen a los 7 días**. En *In production* no vencen por tiempo, salvo que pasen 6 meses sin usarse (aquí se usan cada 5 minutos) o que revoques el acceso. Para uso personal no hace falta la verificación de Google: al conectar verás el aviso «Google no verificó esta app»; pulsa **Configuración avanzada → Ir a pizarra-semanal (no seguro)**. Es tu propia app y solo pide leer el calendario. Una app sin verificar admite hasta 100 usuarios, de sobra para una persona.

### 4. TickTick

1. En <https://developer.ticktick.com/manage>, abre tu app.
2. En **OAuth redirect URL** pon `https://pizarra-semanal.<tu-subdominio>.workers.dev/oauth/ticktick/callback`.
3. Copia el **Client ID** y el **Client Secret**.

> **Sobre la expiración.** La Open API de TickTick solo documenta `grant_type=authorization_code`, sin refresh token. Cuando el access token vence, el panel muestra «Volver a conectar TickTick» y basta un clic. Alternativa: un **token personal** (TickTick → Ajustes → Cuenta → API Token) cargado como secreto `TICKTICK_API_TOKEN`. Se usa solo si no hay un token OAuth válido.

### 5. Secretos del Worker

Hay dos formas de cargarlos.

**Opción A: panel de Cloudflare (recomendada para pegar credenciales).** Workers & Pages → pizarra-semanal → Settings → **Variables and Secrets** → *Add* → tipo **Secret** → nombre y valor → *Deploy*. Aquí pegar con Ctrl+V funciona normal.

**Opción B: terminal.** Wrangler pide cada valor en un campo oculto:

> ⚠️ En algunas terminales (por ejemplo el panel de terminal de Claude o PowerShell dentro de ciertos editores) **Ctrl+V no pega en el campo oculto**: guarda el carácter de control `\u0016` como si fuera el valor. Si usas la terminal, pega con clic derecho o Ctrl+Shift+V, y después comprueba el resultado en `/api/status` (ver paso 6).

```bash
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put TICKTICK_CLIENT_ID
npx wrangler secret put TICKTICK_CLIENT_SECRET
npx wrangler secret put ACCESS_TEAM_DOMAIN
npx wrangler secret put ACCESS_AUD
npx wrangler secret put ALLOWED_EMAILS
npx wrangler secret put TOKEN_ENCRYPTION_KEY
```

- `ACCESS_TEAM_DOMAIN`: `https://<team>.cloudflareaccess.com`
- `ALLOWED_EMAILS`: tu correo (varios, separados por comas)
- `TOKEN_ENCRYPTION_KEY`: 32 bytes aleatorios en base64. Genéralos con:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  ```
  Si lo cambias más adelante, los tokens guardados dejan de poder leerse y hay que volver a conectar las cuentas.

  Los valores que no requieren copiar y pegar se pueden cargar sin prompt, por tubería:
  ```bash
  node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" | npx wrangler secret put TOKEN_ENCRYPTION_KEY
  ```

Los espacios, saltos de línea o comillas pegados por accidente al principio o al final se ignoran.

### 6. Primer inicio de sesión OAuth

1. Abre `https://pizarra-semanal.<tu-subdominio>.workers.dev`, entra con Access (código al correo) y verás «Google Calendar no está conectado» y «TickTick no está conectado».
2. Abre `/api/status` y revisa la sección `config`: muestra el Client ID de Google (es público) y, para cada secreto, solo si está cargado, su longitud y si el formato es el esperado. Debe verse `googleClientIdFormatOk: true`, `googleClientSecret.formatOk: true` y longitudes mayores que 1 en los de TickTick.
3. Pulsa **Conectar Google Calendar**, elige tu cuenta y acepta (ver el aviso de app no verificada más arriba).
4. Pulsa **Conectar TickTick** y autoriza.
5. Abre `/api/debug/ticktick` y revisa que `onlyInUndone` y `onlyInScan` estén vacíos. Si `onlyInScan` tiene tareas, `POST /task/undone` no está devolviendo todo lo que el panel necesita: cambia `TICKTICK_STRATEGY` a `"scan"` en `wrangler.jsonc` y vuelve a desplegar.

### 7. Despliegue automático con GitHub Actions

1. Crea un repositorio en GitHub y sube el código. Puede ser público: el repo no contiene secretos ni datos personales (las credenciales viven en Cloudflare y `.env` está en `.gitignore`).
   ```bash
   git remote add origin https://github.com/<usuario>/<repo>.git
   git push -u origin main
   ```
2. En Cloudflare: **My Profile → API Tokens → Create Token →** plantilla **Edit Cloudflare Workers**. Limítalo a tu cuenta.
3. En GitHub: **Settings → Secrets and variables → Actions → New repository secret**:
   - `CLOUDFLARE_API_TOKEN`: el token del paso anterior
   - `CLOUDFLARE_ACCOUNT_ID`: el Account ID (lo muestra `npx wrangler whoami` o la URL del dashboard, `dash.cloudflare.com/<account-id>/…`)

Cada push a `main` ejecuta typecheck y pruebas y, si pasan, despliega. Los pull requests solo ejecutan las pruebas. Los secretos de la app no pasan por GitHub: el despliegue conserva los que ya están en Cloudflare.

### 8. En el celular

Abre la URL en el navegador, inicia sesión con Access y usa **Agregar a la pantalla de inicio** (Safari) o **Instalar app** (Chrome). Para no repetir el código de acceso a menudo, sube la *Session duration* de la aplicación en Access (paso 2.4).

---

## Problemas frecuentes

| Síntoma | Causa | Solución |
|---|---|---|
| Google: **Error 401 `invalid_client`** («The OAuth client was not found») | El `GOOGLE_CLIENT_ID` guardado no es el Client ID (pegado mal, invertido con el secret, o el carácter `\u0016` de un Ctrl+V fallido). Si es idéntico al de Google Cloud, el cliente es muy nuevo. | Revisa `config` en `/api/status` y vuelve a cargarlo desde el panel de Cloudflare. Si coincide, espera 5–10 minutos. |
| Google: **Error 403 `access_denied`** («no ha completado el proceso de verificación») | La app sigue en modo *Testing*. | Completa el Branding y pulsa **Publish app** (paso 3). |
| Google no deja publicar: «Se requieren un nombre de app, un correo…» | Faltan campos del Branding. | Completa la tabla del paso 3, incluida la URL `/privacy`. |
| «Google no envió refresh token» | Ya habías autorizado la app antes. | Quita el acceso en <https://myaccount.google.com/permissions> y vuelve a conectar. |
| «El intercambio del código falló (401)» | Client ID o secret de ese proveedor mal cargados. | Revisa `config` en `/api/status` y corrígelos. |
| «Tu acceso a TickTick expiró» | El access token de TickTick venció (no tiene refresh token). | Pulsa **Volver a conectar TickTick**. |
| «Acceso restringido» / 503 | Faltan `ACCESS_TEAM_DOMAIN` o `ACCESS_AUD`. | Cárgalos (paso 5). |
| PowerShell: *execution policy* al usar `npx` | Windows bloquea `npx.ps1`. | Usa `npx.cmd`. |
| GitHub Actions: falla el paso de despliegue | Faltan `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` en GitHub. | Paso 7. |

---

## Desarrollo local

```bash
cp .env.example .env      # en Windows: copy .env.example .env
```

- Con `DEV_MODE=true`, la validación de Access se salta **solo** si la petición llega a `localhost`/`127.0.0.1`. En Cloudflare eso nunca ocurre.
- Con `MOCK_DATA=true` se sirven datos inventados (sin cuentas reales) y se recorre todo el pipeline: normalización, filtros y frontend.
- Con `MOCK_DATA=false` y las credenciales de Google y TickTick en `.env`, puedes conectar tus cuentas en local (el redirect URI de localhost debe estar registrado; TickTick quizá admita una sola URL de redirección, así que en local puede ser más cómodo usar `TICKTICK_API_TOKEN`).

```bash
npm run dev        # http://localhost:8787
npm test           # pruebas
npm run typecheck
```

## Notas sobre las APIs (verificadas en la documentación oficial)

- **TickTick** ([Open API](https://developer.ticktick.com/docs/openapi.md)):
  - Fechas con formato `yyyy-MM-dd'T'HH:mm:ssZ` y offset sin dos puntos (`+0000`, `-0500`); se normalizan antes de parsear.
  - Las tareas de día completo se ubican en el día según la zona horaria de la propia tarea y no muestran hora.
  - Hay filtro por fechas: `POST /open/v1/task/undone` (rango de hasta 14 días, todos los proyectos incluido el inbox). El panel parte los rangos largos en tramos de 14 días. La doc no dice si el rango se aplica a `dueDate` o a `startDate`; por eso el backend vuelve a filtrar por fecha de vencimiento y existe `/api/debug/ticktick` para comprobarlo.
  - El objeto Task documentado no trae columna, pero en la práctica las respuestas sí incluyen `columnId` en listas con columnas (incluido el inbox). La etiqueta muestra «Lista · Columna»; en el inbox, solo la columna.
  - Verificado con datos reales: `/task/undone` y el recorrido completo de proyectos devuelven las mismas tareas, por eso la estrategia por defecto es `undone`.
- **Google Calendar** ([events.list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)): `calendars/primary/events` con `singleEvents=true`, `orderBy=startTime`, `timeMin`/`timeMax` en RFC3339 y `timeZone=America/Lima`. Scope `calendar.readonly`.
