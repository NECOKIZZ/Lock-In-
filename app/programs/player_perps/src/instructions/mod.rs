//! Instruction handlers, grouped by lifecycle stage.

pub mod fast_path;
pub mod lifecycle;
pub mod pipeline;

pub use fast_path::*;
pub use lifecycle::*;
pub use pipeline::*;
