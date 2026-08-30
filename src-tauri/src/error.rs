use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("数据操作失败：{0}")]
    Database(#[from] rusqlite::Error),
    #[error("{0}")]
    Validation(String),
    #[error("未找到：{0}")]
    NotFound(String),
    #[error("文件操作失败：{0}")]
    Io(#[from] std::io::Error),
}

pub type AppResult<T> = Result<T, AppError>;

impl serde::Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
