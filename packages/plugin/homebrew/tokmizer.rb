class Tokmizer < Formula
  desc "Cuts the tokens your AI coding agent burns on command output"
  homepage "https://tokmizer.com"
  url "https://registry.npmjs.org/@tokmizer/plugin/-/plugin-1.2.6.tgz"
  sha256 "c1d508cbef8ffe51e689caa34ce71d276383a9e36b2a56909fed4640e36d11f6"
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
