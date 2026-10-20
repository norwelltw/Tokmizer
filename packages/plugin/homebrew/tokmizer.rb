class Tokmizer < Formula
  desc "Cuts the tokens your AI coding agent burns on command output"
  homepage "https://tokmizer.com"
  url "https://registry.npmjs.org/@tokmizer/plugin/-/plugin-1.0.1.tgz"
  sha256 "f584770a935ca78e531a3d181b3e0e1f652ec0a1af4fa3da01cac5c208938f34"
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
