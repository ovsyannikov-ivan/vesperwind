pub mod content;
pub mod filesystem;
pub mod media;
pub mod runtime;
pub mod settings;
pub mod terminal;

use crate::error::NativeError;
use serde::Serialize;
use serde_json::{json, Value};

pub fn success<T: Serialize>(field: &str, value: T) -> Value {
    let mut response = serde_json::Map::new();
    response.insert("ok".to_string(), Value::Bool(true));
    response.insert(
        field.to_string(),
        serde_json::to_value(value).unwrap_or(Value::Null),
    );
    Value::Object(response)
}

pub fn failure(error: NativeError) -> Value {
    json!({ "ok": false, "error": error })
}
