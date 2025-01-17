package abi45_0_0.expo.modules.constants

import android.content.Context

import abi45_0_0.expo.modules.core.BasePackage
import abi45_0_0.expo.modules.core.interfaces.InternalModule
import abi45_0_0.expo.modules.core.ExportedModule

class ConstantsPackage : BasePackage() {
  override fun createInternalModules(context: Context): List<InternalModule> =
    listOf(ConstantsService(context))

  override fun createExportedModules(context: Context): List<ExportedModule> =
    listOf(ConstantsModule(context))
}
