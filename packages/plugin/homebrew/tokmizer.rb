class Tokmizer < Formula
  desc "Cuts the tokens your AI coding agent burns on command output"
  homepage "https://tokmizer.com"
  url "https://registry.npmjs.org/@tokmizer/plugin/-/plugin-1.1.6.tgz"
  sha256 "e437cfdb263742db482bda9579930a54cb44e6dd997faf4df2c3ad9bf86ad8ab"
  license all_of: ["Apache-2.0", "BUSL-1.1"]

  depends_on "node"

  def install
    system "npm", "install", *std_npm_args
    bin.install_symlink Dir["#{libexec}/bin/*"]
  end

  test do
    assert_match "Usage: tkr", shell_output("#{bin}/tkr help")
  end
end
