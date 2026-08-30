use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;

use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::error::{AppError, AppResult};

pub struct PreparedPdf {
    pub managed_path: PathBuf,
    pub file_hash: String,
    pub reused_managed_file: bool,
}

pub fn prepare_pdf_copy(source_path: &Path, library_directory: &Path) -> AppResult<PreparedPdf> {
    let source_path = source_path.canonicalize()?;
    if !source_path.is_file() {
        return Err(AppError::Validation("选择的 PDF 文件不存在。".into()));
    }
    let is_pdf_extension = source_path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("pdf"));
    if !is_pdf_extension {
        return Err(AppError::Validation("请选择扩展名为 .pdf 的文件。".into()));
    }

    fs::create_dir_all(library_directory)?;
    let temporary_path = library_directory.join(format!(".import-{}.tmp", Uuid::new_v4()));
    let result = copy_and_hash(&source_path, &temporary_path, library_directory);
    if result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    result
}

fn copy_and_hash(
    source_path: &Path,
    temporary_path: &Path,
    library_directory: &Path,
) -> AppResult<PreparedPdf> {
    let mut source = File::open(source_path)?;
    let mut temporary = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(temporary_path)?;
    let mut buffer = vec![0_u8; 1024 * 1024];
    let first_read = source.read(&mut buffer)?;
    if first_read == 0
        || !buffer[..first_read.min(1024)]
            .windows(5)
            .any(|window| window == b"%PDF-")
    {
        return Err(AppError::Validation(
            "文件内容不是有效的 PDF（未找到 PDF 文件头）。".into(),
        ));
    }

    let mut hasher = Sha256::new();
    hasher.update(&buffer[..first_read]);
    temporary.write_all(&buffer[..first_read])?;
    loop {
        let read = source.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        temporary.write_all(&buffer[..read])?;
    }
    temporary.flush()?;
    temporary.sync_all()?;
    drop(temporary);

    let file_hash = format!("{:x}", hasher.finalize());
    let managed_path = library_directory.join(format!("{file_hash}.pdf"));
    let reused_managed_file = if managed_path.exists() {
        fs::remove_file(temporary_path)?;
        true
    } else {
        match fs::rename(temporary_path, &managed_path) {
            Ok(()) => false,
            Err(_) if managed_path.exists() => {
                fs::remove_file(temporary_path)?;
                true
            }
            Err(error) => return Err(AppError::Io(error)),
        }
    };

    Ok(PreparedPdf {
        managed_path,
        file_hash,
        reused_managed_file,
    })
}

pub fn read_managed_pdf(path: &Path, library_directory: &Path) -> AppResult<Vec<u8>> {
    let canonical_path = validated_managed_pdf_path(path, library_directory)?;
    Ok(fs::read(canonical_path)?)
}

pub fn reveal_managed_pdf(path: &Path, library_directory: &Path) -> AppResult<()> {
    let canonical_path = validated_managed_pdf_path(path, library_directory)?;

    #[cfg(target_os = "windows")]
    Command::new("explorer.exe")
        .arg("/select,")
        .arg(&canonical_path)
        .spawn()?;

    #[cfg(target_os = "macos")]
    Command::new("open")
        .arg("-R")
        .arg(&canonical_path)
        .spawn()?;

    #[cfg(all(unix, not(target_os = "macos")))]
    Command::new("xdg-open")
        .arg(
            canonical_path
                .parent()
                .ok_or_else(|| AppError::Validation("无法确定文献所在目录。".into()))?,
        )
        .spawn()?;

    Ok(())
}

pub fn discard_managed_pdf(path: &Path, library_directory: &Path) -> AppResult<()> {
    let canonical_path = validated_managed_pdf_path(path, library_directory)?;
    match fs::remove_file(canonical_path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(AppError::Io(error)),
    }
}

fn validated_managed_pdf_path(path: &Path, library_directory: &Path) -> AppResult<PathBuf> {
    let canonical_library = library_directory.canonicalize()?;
    let canonical_path = path.canonicalize()?;
    if !canonical_path.starts_with(&canonical_library) {
        return Err(AppError::Validation(
            "文献文件不在砚台管理的本地文献库中。".into(),
        ));
    }
    if !canonical_path.is_file() {
        return Err(AppError::Validation("文献管理副本不存在。".into()));
    }
    Ok(canonical_path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_file_is_not_kept_in_managed_library() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-pdf-files")
            .join(Uuid::new_v4().to_string());
        fs::create_dir_all(&root).expect("create test directory");
        let source = root.join("not-a-pdf.pdf");
        fs::write(&source, b"plain text").expect("write invalid source");
        let library = root.join("managed");

        let result = prepare_pdf_copy(&source, &library);
        assert!(matches!(result, Err(AppError::Validation(_))));
        let kept_files = fs::read_dir(&library)
            .expect("read library")
            .collect::<Result<Vec<_>, _>>()
            .expect("collect library files");
        assert!(kept_files.is_empty());

        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn managed_reader_rejects_a_path_outside_the_library() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("test-pdf-files")
            .join(Uuid::new_v4().to_string());
        fs::create_dir_all(&root).expect("create test directory");
        let library = root.join("managed");
        fs::create_dir_all(&library).expect("create managed directory");
        let outside = root.join("outside.pdf");
        fs::write(&outside, b"%PDF-1.4\noutside\n").expect("write outside PDF");

        let result = read_managed_pdf(&outside, &library);
        assert!(matches!(result, Err(AppError::Validation(_))));

        fs::remove_dir_all(root).expect("remove test directory");
    }
}
