use rustpad_server::{auth, database::Database, server, ServerConfig};

#[tokio::main]
async fn main() {
    dotenv::dotenv().ok();
    pretty_env_logger::init();

    let port = std::env::var("PORT")
        .unwrap_or_else(|_| String::from("3030"))
        .parse()
        .expect("Unable to parse PORT");

    // AuthPad requires a database (users + sessions). Default to a local file.
    let sqlite_uri =
        std::env::var("SQLITE_URI").unwrap_or_else(|_| String::from("sqlite://authpad.db"));
    let database = Database::new(&sqlite_uri)
        .await
        .expect("Unable to connect to SQLITE_URI");

    // Seed users from the backend-only seed file (the only way users are created).
    let seed_file = std::env::var("SEED_FILE").unwrap_or_else(|_| String::from("seed_users.json"));
    auth::seed_from_file(&database, &seed_file).await;

    let config = ServerConfig {
        expiry_days: std::env::var("EXPIRY_DAYS")
            .unwrap_or_else(|_| String::from("1"))
            .parse()
            .expect("Unable to parse EXPIRY_DAYS"),
        database: Some(database),
    };

    warp::serve(server(config)).run(([0, 0, 0, 0], port)).await;
}
