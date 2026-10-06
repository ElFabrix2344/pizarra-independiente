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
| GET | `/api/status` | Qué cuentas están conectadas |
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
public/                 frontend (HTML, CSS, JS sin framework)
test/                   pruebas (vitest)
```

`src/lib/ticktick/` es independiente: recibe una función que devuelve el access token y no sabe nada de KV ni de Cloudflare. Se puede copiar o importar en otro proyecto (por ejemplo, para crear tareas a partir de un sílabo).

---

## Configuración paso a paso

Necesitas Node.js 22.12 o superior. Abre una terminal en la carpeta del proyecto:

```bash
npm install
```

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
   La URL será `https://pizarra-semanal.<tu-subdominio>.workers.dev`. Mientras Access no esté configurado, el Worker **no sirve nada** (responde 503): falla cerrado.

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
   - **Branding**: nombre de la app y tu correo de soporte.
   - **Audience**: tipo **External**. Pulsa **Publish app** para pasar a **In production**. *No envíes la app a verificación.*
   - **Data access**: agrega el scope `https://www.googleapis.com/auth/calendar.readonly`.
4. **Clients → Create client → Web application**. En *Authorized redirect URIs* agrega:
   - `https://pizarra-semanal.<tu-subdominio>.workers.dev/oauth/google/callback`
   - `http://localhost:8787/oauth/google/callback` (para desarrollo local)

   Guarda el **Client ID** y el **Client secret**.

> **Por qué "In production" y no "Testing".** Con tipo External y estado *Testing*, Google emite refresh tokens que **vencen a los 7 días**. En *In production* no vencen por tiempo, salvo que pasen 6 meses sin usarse (aquí se usan cada 5 minutos) o que revoques el acceso. Para uso personal no hace falta la verificación de Google: al conectar verás el aviso «Google no verificó esta app»; pulsa **Configuración avanzada → Ir a pizarra-semanal (no seguro)**. Es tu propia app y solo pide leer el calendario. Una app sin verificar admite hasta 100 usuarios, de sobra para una persona.

### 4. TickTick

1. En <https://developer.ticktick.com/manage>, abre tu app.
2. En **OAuth redirect URL** pon `https://pizarra-semanal.<tu-subdominio>.workers.dev/oauth/ticktick/callback`.
3. Copia el **Client ID** y el **Client Secret**.

> **Sobre la expiración.** La Open API de TickTick solo documenta `grant_type=authorization_code`, sin refresh token. Cuando el access token vence, el panel muestra «Volver a conectar TickTick» y basta un clic. Alternativa: un **token personal** (TickTick → Ajustes → Cuenta → API Token) cargado como secreto `TICKTICK_API_TOKEN`. Se usa solo si no hay un token OAuth válido.

### 5. Secretos del Worker

Carga cada valor; wrangler te lo pedirá de forma interactiva, así que no queda en el historial de la terminal:

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

### 6. Primer inicio de sesión OAuth

1. Abre `https://pizarra-semanal.<tu-subdominio>.workers.dev`, entra con Access (código al correo) y verás «Google Calendar no está conectado» y «TickTick no está conectado».
2. Pulsa **Conectar Google Calendar**, elige tu cuenta y acepta (ver el aviso de app no verificada más arriba).
3. Pulsa **Conectar TickTick** y autoriza.
4. Abre `/api/debug/ticktick` y revisa que `onlyInUndone` y `onlyInScan` estén vacíos. Si `onlyInScan` tiene tareas, `POST /task/undone` no está devolviendo todo lo que el panel necesita: cambia `TICKTICK_STRATEGY` a `"scan"` en `wrangler.jsonc` y vuelve a desplegar.

### 7. Despliegue automático con GitHub Actions

1. Crea un repositorio **privado** en GitHub y sube el código:
   ```bash
   git remote add origin https://github.com/<usuario>/pizarra-semanal.git
   git push -u origin main
   ```
2. En Cloudflare: **My Profile → API Tokens → Create Token →** plantilla **Edit Cloudflare Workers**. Limítalo a tu cuenta.
3. En GitHub: **Settings → Secrets and variables → Actions → New repository secret**:
   - `CLOUDFLARE_API_TOKEN`: el token del paso anterior
   - `CLOUDFLARE_ACCOUNT_ID`: el Account ID (aparece en el dashboard de Cloudflare, en la barra lateral de Workers & Pages)

Cada push a `main` ejecuta typecheck y pruebas y, si pasan, despliega. Los pull requests solo ejecutan las pruebas.

### 8. En el celular

Abre la URL en el navegador, inicia sesión con Access y usa **Agregar a la pantalla de inicio** (Safari) o **Instalar app** (Chrome).

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
  - El objeto Task documentado no trae columna. La etiqueta muestra el nombre de la lista y, si la respuesta incluye `columnId`, también la columna.
- **Google Calendar** ([events.list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)): `calendars/primary/events` con `singleEvents=true`, `orderBy=startTime`, `timeMin`/`timeMax` en RFC3339 y `timeZone=America/Lima`. Scope `calendar.readonly`.
