use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tauri::State;

// Holds the bound-but-not-yet-consumed loopback listener between the two
// OAuth commands below — start_oauth_listener binds it and hands the port to
// JS (to build the redirect_uri), await_oauth_callback later takes ownership
// and blocks on it. No deep-link plugin/OS URL-scheme registration needed —
// this is the RFC 8252 loopback pattern for native app OAuth redirects.
struct OAuthListenerState(Mutex<Option<tiny_http::Server>>);

#[derive(serde::Serialize)]
struct OAuthCallbackResult {
    code: Option<String>,
    state: Option<String>,
    error: Option<String>,
}

#[tauri::command]
fn start_oauth_listener(state: State<OAuthListenerState>) -> Result<u16, String> {
    let std_listener = std::net::TcpListener::bind("127.0.0.1:0").map_err(|e| e.to_string())?;
    let port = std_listener.local_addr().map_err(|e| e.to_string())?.port();
    let server = tiny_http::Server::from_listener(std_listener, None).map_err(|e| e.to_string())?;
    *state.0.lock().unwrap() = Some(server);
    log::info!("oauth loopback listener bound on 127.0.0.1:{}", port);
    Ok(port)
}

#[tauri::command]
async fn await_oauth_callback(
    state: State<'_, OAuthListenerState>,
) -> Result<OAuthCallbackResult, String> {
    let server = state
        .0
        .lock()
        .unwrap()
        .take()
        .ok_or("oauth listener not started")?;

    tauri::async_runtime::spawn_blocking(move || -> Result<OAuthCallbackResult, String> {
        let request = server
            .recv_timeout(Duration::from_secs(300))
            .map_err(|e| e.to_string())?
            .ok_or("timed out waiting for OAuth redirect")?;

        // request.url() is just the request-target (path + query) — parse
        // against a dummy base to pull out the query params with the `url` crate.
        let full_url = format!("http://127.0.0.1{}", request.url());
        let parsed = url::Url::parse(&full_url).map_err(|e| e.to_string())?;

        let mut code = None;
        let mut cb_state = None;
        let mut error = None;
        for (k, v) in parsed.query_pairs() {
            match k.as_ref() {
                "code" => code = Some(v.into_owned()),
                "state" => cb_state = Some(v.into_owned()),
                "error" => error = Some(v.into_owned()),
                _ => {}
            }
        }

        log::info!(
            "oauth loopback received callback (code present: {}, error: {:?})",
            code.is_some(),
            error
        );

        // Redirect to a real branded confirmation page instead of serving inline
        // HTML from the listener — matches the "return to the app" page
        // MagicVerify.jsx already shows for the magic-link bridge flow.
        let response = tiny_http::Response::empty(302).with_header(
            tiny_http::Header::from_bytes(
                &b"Location"[..],
                &b"https://www.oodbo.io/desktop/oauth-complete"[..],
            )
            .unwrap(),
        );
        let _ = request.respond(response);

        Ok(OAuthCallbackResult {
            code,
            state: cb_state,
            error,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

// Microsoft's token endpoint rejects the authorization_code/refresh_token
// exchange with AADSTS90023 ("Cross-origin token redemption...") when it's
// called via fetch() from a webview — WebView2 sends an Origin header like
// any browser, and Azure only allows that for SPA-registered clients or a
// Native client with the origin on an allow-list that isn't self-service in
// the Portal. Doing the exchange from Rust instead sends no Origin header at
// all, sidestepping the restriction entirely (Google's token endpoint has no
// such check, so it stays a plain fetch() from desktopOAuth.js).
#[tauri::command]
async fn azure_token_request(params: HashMap<String, String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let form: Vec<(&str, &str)> = params.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
        let result = ureq::post("https://login.microsoftonline.com/common/oauth2/v2.0/token")
            .send_form(&form);
        let body = match result {
            Ok(resp) => resp.into_string(),
            // Azure's error JSON (e.g. invalid_grant) still needs to reach the
            // caller so it can read error_description — forward the body either way.
            Err(ureq::Error::Status(_, resp)) => resp.into_string(),
            Err(e) => return Err(e.to_string()),
        };
        body.map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Microsoft Graph GET with the provider bearer token, executed in Rust so it bypasses the WebView's
// CSP/connect-src. Needed for file content: Graph's /content endpoint 302-redirects to a Microsoft
// download host that isn't (and can't reliably be) in the app CSP, so a webview fetch() is blocked
// ("Failed to fetch"). ureq follows the redirect server-side. A 2xx returns the body; a Status error
// is forwarded as "status:<code>" so the JS caller can map 404 → notFound and 401/403 → typed errors.
#[tauri::command]
async fn azure_graph_get(url: String, token: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let result = ureq::get(&url)
            .set("Authorization", &format!("Bearer {}", token))
            .call();
        match result {
            Ok(resp) => resp.into_string().map_err(|e| e.to_string()),
            Err(ureq::Error::Status(code, _resp)) => Err(format!("status:{}", code)),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Corporate proxies can intercept the app's OWN internal origin (http://tauri.localhost) and
    // route it to a local server (e.g. JBoss/Agiloft), so the bundled frontend fails to load with a
    // 404. Bypass the proxy for the local app origin only — external API calls (oodbo.io, Google,
    // Microsoft Graph) still go through the proxy, which corporate networks require. Must be set
    // before the WebView2 environment is created. WebView2/Chromium honours --proxy-bypass-list
    // against the active (system) proxy.
    #[cfg(target_os = "windows")]
    std::env::set_var(
        "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
        "--proxy-bypass-list=tauri.localhost;*.localhost;localhost;127.0.0.1;[::1]",
    );

    tauri::Builder::default()
        .manage(OAuthListenerState(Mutex::new(None)))
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            start_oauth_listener,
            await_oauth_callback,
            azure_token_request,
            azure_graph_get
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
