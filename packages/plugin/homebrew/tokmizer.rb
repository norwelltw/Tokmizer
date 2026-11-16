class Tokmizer < Formula
  desc "Cuts the tokens your AI coding agent burns on command output"
  homepage "https://tokmizer.com"
  url "https://registry.npmjs.org/@tokmizer/plugin/-/plugin-1.2.4.tgz"
  sha256 "f116d98dfa2cd02625f0932b7e9052900359f618a4bf81503a6a3303ff3ccdfe"
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
